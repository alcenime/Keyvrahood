/*!
 * KEYVRA — wallet.js
 * -----------------------------------------------------------------------
 * Real wallet connection layer for the KEYVRA static site (GitHub Pages /
 * keyvra.xyz). No fake addresses, no fake balances.
 *
 * DESIGN CONTRACT (do not break):
 *  1. The CONNECT WALLET button is rendered synchronously, the instant this
 *     file executes — before Reown AppKit (or anything async) is touched.
 *  2. If Reown AppKit's CDN/module fails to load for any reason, the button
 *     never disappears. We log a clear console error and fall back to a
 *     manual EIP-6963 injected-wallet picker instead of relying on
 *     `window.ethereum` alone.
 *  3. Public API is preserved exactly:
 *       window.KeyvraWallet.connect()
 *       window.KeyvraWallet.disconnect()
 *       window.KeyvraWallet.isConnected()
 *       window.KeyvraWallet.getAddress()
 *       window.KeyvraWallet.getChainId()
 *       window.KeyvraWallet.getBalances()      // sync, returns cached values
 *       window.KeyvraWallet.formatBalance(v,s) // sync formatter
 *  4. No HTML/CSS is touched. This file only ever writes into the existing
 *     `#walletArea` mount point(s) already present in the markup, reusing
 *     the `.wallet-btn` / `.account-wrap` / `.account-dropdown` classes
 *     that are already defined in each page's <style>.
 * -----------------------------------------------------------------------
 */
(function () {
  'use strict';

  // ======================================================================
  // CONFIG — edit these, nothing else needs to change for a new deployment
  // ======================================================================
  var PROJECT_ID = '126440cebeafcb400605e0ae20e9b55f';

  var CHAIN = {
    id: 4663,
    hex: '0x' + (4663).toString(16), // 0x1237
    name: 'Robinhood Chain',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: '' // fill in a block explorer base URL if/when one exists
  };

  // Optional ERC-20 tokens to surface via getBalances(). Leave address as
  // null until a real deployed contract exists — we will never invent one.
  // `decimals: null` means "read decimals() from the contract itself at
  // runtime" instead of guessing — safer than hardcoding a wrong value.
  var TOKENS = {
    usdg: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: null, symbol: 'USDG' }
  };

  var METADATA = {
    name: 'KEYVRA',
    description: 'Stake KEYVRA. Earn yield on Robinhood Chain.',
    url: window.location.origin,
    icons: [window.location.origin + '/favicon.ico']
  };

  // ======================================================================
  // STATE
  // ======================================================================
  var state = {
    address: null,
    chainId: null,
    connected: false,
    connecting: false,
    mode: null,           // 'appkit' | 'injected'
    injectedProvider: null,
    balances: {}          // cached, synchronous getBalances() reads this
  };

  var mounts = [];
  var appKit = null;
  var appKitReady = false;
  var appKitLoadPromise = null;
  var announcedProviders = []; // EIP-6963 { info, provider }

  // ======================================================================
  // SMALL DOM HELPERS
  // ======================================================================
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function shortAddr(a) {
    if (!a) return '';
    return a.slice(0, 6) + '\u2026' + a.slice(-4);
  }

  function fireChange() {
    try {
      if (typeof window.onWalletChange === 'function') window.onWalletChange();
    } catch (e) {
      console.error('[KeyvraWallet] onWalletChange listener threw:', e);
    }
    renderAll();
  }

  // ======================================================================
  // STEP 1 — RENDER THE BUTTON IMMEDIATELY, SYNCHRONOUSLY, NO ASYNC WORK
  // ======================================================================
  function findMounts() {
    mounts = [];
    var main = document.getElementById('walletArea');
    if (main) mounts.push(main);
    // Some pages may use a class instead of the id — support both so this
    // works from any KEYVRA page without HTML edits.
    var extra = document.querySelectorAll('.wallet-area');
    for (var i = 0; i < extra.length; i++) {
      if (mounts.indexOf(extra[i]) === -1) mounts.push(extra[i]);
    }
  }

  function renderDisconnected(mount) {
    mount.innerHTML = '';
    var btn = el('button', 'wallet-btn', '\u25A4 CONNECT WALLET');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Connect wallet');
    btn.addEventListener('click', function () {
      connect();
    });
    mount.appendChild(btn);
  }

  function renderConnected(mount) {
    mount.innerHTML = '';
    var wrap = el('div', 'account-wrap');
    var btn = el('button', 'wallet-btn', shortAddr(state.address));
    btn.type = 'button';

    var dropdown = el('div', 'account-dropdown');

    var profileLink = el('a', '', 'PROFILE');
    profileLink.href = 'profile.html';

    var networkRow = el('button', '', (state.chainId === CHAIN.id ? 'ROBINHOOD CHAIN' : 'WRONG NETWORK \u2014 SWITCH'));
    networkRow.type = 'button';
    if (state.chainId !== CHAIN.id) {
      networkRow.addEventListener('click', function (e) {
        e.stopPropagation();
        switchToRobinhoodChain();
      });
    } else {
      networkRow.disabled = true;
      networkRow.style.opacity = '0.6';
      networkRow.style.cursor = 'default';
    }

    var copyBtn = el('button', '', 'COPY ADDRESS');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(state.address).catch(function () {});
      }
      copyBtn.textContent = 'COPIED';
      setTimeout(function () { copyBtn.textContent = 'COPY ADDRESS'; }, 1200);
    });

    var disconnectBtn = el('button', 'disconnect', 'DISCONNECT');
    disconnectBtn.type = 'button';
    disconnectBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      disconnect();
    });

    dropdown.appendChild(profileLink);
    dropdown.appendChild(networkRow);
    dropdown.appendChild(copyBtn);
    dropdown.appendChild(disconnectBtn);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', function () {
      dropdown.classList.remove('open');
    });

    wrap.appendChild(btn);
    wrap.appendChild(dropdown);
    mount.appendChild(wrap);
  }

  function renderAll() {
    for (var i = 0; i < mounts.length; i++) {
      if (state.connected) renderConnected(mounts[i]);
      else renderDisconnected(mounts[i]);
    }
  }

  // Run immediately. wallet.js is loaded at the end of <body>, so the DOM
  // (including #walletArea) already exists — no need to wait for
  // DOMContentLoaded, and we deliberately do NOT await anything above this.
  findMounts();
  renderAll();

  // ======================================================================
  // BALANCES — real on-chain reads via public RPC, independent of which
  // wallet/provider is connected. Cached into state.balances; getBalances()
  // stays synchronous per the existing API contract.
  // ======================================================================
  function hexToEtherString(hexWei, decimals) {
    try {
      var wei = BigInt(hexWei);
      var base = BigInt(10) ** BigInt(decimals);
      var whole = wei / base;
      var frac = wei % base;
      var fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
      return fracStr ? (whole.toString() + '.' + fracStr) : whole.toString();
    } catch (e) {
      return null;
    }
  }

  function rpcCall(method, params) {
    return fetch(CHAIN.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params || [] })
    })
      .then(function (r) {
        return r.text().then(function (text) {
          var json;
          try { json = JSON.parse(text); }
          catch (e) { throw new Error('RPC ' + method + ' returned non-JSON (HTTP ' + r.status + '): ' + text.slice(0, 200)); }
          if (json.error) throw new Error('RPC ' + method + ' error: ' + JSON.stringify(json.error));
          return json.result;
        });
      });
  }

  function erc20BalanceOf(tokenAddress, owner) {
    // balanceOf(address) selector = 0x70a08231
    var data = '0x70a08231' + owner.replace('0x', '').padStart(64, '0');
    return rpcCall('eth_call', [{ to: tokenAddress, data: data }, 'latest']);
  }

  var decimalsCache = {}; // tokenAddress (lowercase) -> resolved decimals (number)
  function erc20Decimals(tokenAddress) {
    var key = tokenAddress.toLowerCase();
    if (decimalsCache[key] !== undefined) return Promise.resolve(decimalsCache[key]);
    // decimals() selector = 0x313ce567
    return rpcCall('eth_call', [{ to: tokenAddress, data: '0x313ce567' }, 'latest'])
      .then(function (hex) {
        var d = parseInt(hex, 16);
        decimalsCache[key] = d;
        return d;
      });
  }

  function refreshBalances() {
    if (!state.address) {
      state.balances = {};
      return Promise.resolve(state.balances);
    }
    var jobs = [];

    jobs.push(
      rpcCall('eth_getBalance', [state.address, 'latest'])
        .then(function (hex) { state.balances.eth = hexToEtherString(hex, CHAIN.currency.decimals); })
        .catch(function (e) {
          console.error('[KeyvraWallet] Failed to fetch ETH balance:', e);
          state.balances.eth = null;
        })
    );

    Object.keys(TOKENS).forEach(function (key) {
      var t = TOKENS[key];
      if (!t.address) { state.balances[key] = null; return; }

      var balancePromise = erc20BalanceOf(t.address, state.address).catch(function (e) {
        console.error('[KeyvraWallet] balanceOf() failed for ' + t.symbol + ' (' + t.address + '):', e.message || e);
        return null;
      });

      var decimalsPromise = (t.decimals !== null)
        ? Promise.resolve(t.decimals)
        : erc20Decimals(t.address).catch(function (e) {
            console.error('[KeyvraWallet] decimals() failed for ' + t.symbol + ' (' + t.address + '), defaulting to 18:', e.message || e);
            return 18;
          });

      jobs.push(
        Promise.all([balancePromise, decimalsPromise]).then(function (res) {
          var balHex = res[0], decimals = res[1];
          if (balHex === null) {
            state.balances[key] = null;
            return;
          }
          var formatted = hexToEtherString(balHex, decimals);
          if (formatted === null) {
            console.error('[KeyvraWallet] Could not parse ' + t.symbol + ' balance hex:', balHex);
          }
          state.balances[key] = formatted;
        })
      );
    });

    return Promise.all(jobs).then(function () {
      fireChange();
      return state.balances;
    });
  }

  // ======================================================================
  // CHAIN SWITCH / ADD (works for both AppKit's injected connector and our
  // own EIP-6963 fallback, since both hand us a standard EIP-1193 provider)
  // ======================================================================
  function switchToRobinhoodChain() {
    var provider = getActiveEip1193Provider();
    if (!provider) return Promise.resolve();
    return provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.hex }] })
      .catch(function (err) {
        if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
          return provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN.hex,
              chainName: CHAIN.name,
              nativeCurrency: CHAIN.currency,
              rpcUrls: [CHAIN.rpc],
              blockExplorerUrls: CHAIN.explorer ? [CHAIN.explorer] : []
            }]
          });
        }
        console.error('[KeyvraWallet] Chain switch failed:', err);
      });
  }

  function getActiveEip1193Provider() {
    if (state.mode === 'injected' && state.injectedProvider) return state.injectedProvider;
    if (state.mode === 'appkit' && appKitReady && appKit && typeof appKit.getWalletProvider === 'function') {
      try { return appKit.getWalletProvider(); } catch (e) { return null; }
    }
    return null;
  }

  // ======================================================================
  // STEP 2 — LOAD REOWN APPKIT ASYNCHRONOUSLY. THIS CAN NEVER BLOCK OR
  // REMOVE THE BUTTON RENDERED ABOVE. ANY FAILURE HERE JUST DISABLES THE
  // "APPKIT" CONNECTION MODE AND FALLS BACK TO EIP-6963.
  // ======================================================================
  function loadAppKit() {
    if (appKitLoadPromise) return appKitLoadPromise;

    appKitLoadPromise = (async function () {
      try {
        var appkitMod = await import('https://esm.sh/@reown/appkit@1.6.8?bundle');
        var ethersAdapterMod = await import('https://esm.sh/@reown/appkit-adapter-ethers@1.6.8?bundle');

        var createAppKit = appkitMod.createAppKit;
        var EthersAdapter = ethersAdapterMod.EthersAdapter;

        if (typeof createAppKit !== 'function' || typeof EthersAdapter !== 'function') {
          throw new Error('Reown AppKit module shape unexpected — createAppKit/EthersAdapter missing.');
        }

        var robinhoodChain = {
          id: CHAIN.id,
          chainNamespace: 'eip155',
          caipNetworkId: 'eip155:' + CHAIN.id,
          name: CHAIN.name,
          nativeCurrency: CHAIN.currency,
          rpcUrls: { default: { http: [CHAIN.rpc] } },
          blockExplorers: CHAIN.explorer ? { default: { name: 'Explorer', url: CHAIN.explorer } } : undefined
        };

        appKit = createAppKit({
          adapters: [new EthersAdapter()],
          networks: [robinhoodChain],
          defaultNetwork: robinhoodChain,
          metadata: METADATA,
          projectId: PROJECT_ID,
          features: { analytics: false, email: false, socials: [] }
        });

        if (typeof appKit.subscribeAccount === 'function') {
          appKit.subscribeAccount(function (acc) {
            if (acc && acc.isConnected && acc.address) {
              state.address = acc.address;
              state.connected = true;
              state.mode = 'appkit';
              if (typeof appKit.getChainId === 'function') {
                try { state.chainId = Number(appKit.getChainId()) || CHAIN.id; } catch (e) { state.chainId = CHAIN.id; }
              } else {
                state.chainId = CHAIN.id;
              }
              refreshBalances();
              fireChange();
            } else if (state.mode === 'appkit') {
              resetState();
              fireChange();
            }
          });
        }

        if (typeof appKit.subscribeNetwork === 'function') {
          appKit.subscribeNetwork(function (net) {
            if (net && net.chainId) state.chainId = Number(net.chainId);
            fireChange();
          });
        }

        appKitReady = true;
        return appKit;
      } catch (err) {
        console.error(
          '[KeyvraWallet] Reown AppKit failed to load or initialize on this static deployment. ' +
          'CONNECT WALLET stays visible; falling back to direct injected-wallet detection (EIP-6963). ' +
          'Error:', err
        );
        appKitReady = false;
        return null;
      }
    })();

    return appKitLoadPromise;
  }

  // Kick off the load in the background immediately, but never await it
  // before rendering — the button above is already on screen.
  loadAppKit();

  // ======================================================================
  // EIP-6963 FALLBACK — used only if AppKit could not be loaded/initialized
  // ======================================================================
  window.addEventListener('eip6963:announceProvider', function (event) {
    var detail = event.detail;
    if (!detail || !detail.provider || !detail.info) return;
    var exists = announcedProviders.some(function (p) { return p.info.uuid === detail.info.uuid; });
    if (!exists) announcedProviders.push(detail);
  });
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) { /* older browsers: ignore */ }

  function openInjectedPicker() {
    return new Promise(function (resolve) {
      // Give EIP-6963 announcements a brief moment to arrive.
      setTimeout(function () {
        var overlay = el('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:center;justify-content:center;';
        var panel = el('div');
        panel.style.cssText = 'background:var(--bg-panel,#0c110b);border:1px solid var(--green-dim,rgba(198,255,61,.35));' +
          'min-width:260px;max-width:90vw;padding:20px;font-family:var(--font-mono,monospace);color:var(--white,#f2f5ec);';

        var title = el('div', '', 'CONNECT A WALLET');
        title.style.cssText = 'font-family:var(--font-display,monospace);font-size:12px;color:var(--green,#c6ff3d);letter-spacing:1px;margin-bottom:14px;';
        panel.appendChild(title);

        if (announcedProviders.length === 0) {
          var empty = el('div', '', 'No browser wallet detected. Install MetaMask, Rainbow, or another EVM wallet extension, or reload once wallet-connect support is back.');
          empty.style.cssText = 'font-size:12px;color:var(--grey,#8a9483);line-height:1.6;margin-bottom:14px;';
          panel.appendChild(empty);
        } else {
          announcedProviders.forEach(function (p) {
            var row = el('button', '', p.info.name);
            row.type = 'button';
            row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;' +
              'border:1px solid var(--green-faint,rgba(198,255,61,.14));color:var(--white,#f2f5ec);padding:12px 14px;' +
              'font-family:var(--font-display,monospace);font-size:10px;letter-spacing:.5px;margin-bottom:8px;cursor:pointer;';
            row.addEventListener('click', function () {
              document.body.removeChild(overlay);
              resolve(p.provider);
            });
            panel.appendChild(row);
          });
        }

        var closeBtn = el('button', '', 'CANCEL');
        closeBtn.type = 'button';
        closeBtn.style.cssText = 'width:100%;background:none;border:1px solid var(--green-dim,rgba(198,255,61,.35));' +
          'color:var(--grey,#8a9483);padding:10px;font-family:var(--font-display,monospace);font-size:10px;cursor:pointer;';
        closeBtn.addEventListener('click', function () {
          document.body.removeChild(overlay);
          resolve(null);
        });
        panel.appendChild(closeBtn);

        overlay.appendChild(panel);
        overlay.addEventListener('click', function (e) {
          if (e.target === overlay) {
            document.body.removeChild(overlay);
            resolve(null);
          }
        });
        document.body.appendChild(overlay);
      }, 150);
    });
  }

  async function connectInjected() {
    var provider = announcedProviders.length === 1 ? announcedProviders[0].provider : await openInjectedPicker();
    if (!provider) return;

    try {
      var accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) return;

      state.address = accounts[0];
      state.injectedProvider = provider;
      state.mode = 'injected';
      state.connected = true;

      var chainIdHex = await provider.request({ method: 'eth_chainId' });
      state.chainId = parseInt(chainIdHex, 16);

      provider.on && provider.on('accountsChanged', function (accs) {
        if (!accs || !accs.length) { resetState(); fireChange(); return; }
        state.address = accs[0];
        refreshBalances();
        fireChange();
      });
      provider.on && provider.on('chainChanged', function (hex) {
        state.chainId = parseInt(hex, 16);
        fireChange();
      });

      if (state.chainId !== CHAIN.id) {
        await switchToRobinhoodChain();
      }

      try { localStorage.setItem('keyvra_wallet_mode', 'injected'); } catch (e) {}
      refreshBalances();
      fireChange();
    } catch (err) {
      console.error('[KeyvraWallet] Injected wallet connection failed:', err);
    }
  }

  // ======================================================================
  // PUBLIC API
  // ======================================================================
  function resetState() {
    state.address = null;
    state.chainId = null;
    state.connected = false;
    state.mode = null;
    state.injectedProvider = null;
    state.balances = {};
    try { localStorage.removeItem('keyvra_wallet_mode'); } catch (e) {}
  }

  async function connect() {
    if (state.connecting || state.connected) return;
    state.connecting = true;
    try {
      await appKitLoadPromise; // wait only for the load we already kicked off
      if (appKitReady && appKit && typeof appKit.open === 'function') {
        await appKit.open();
      } else {
        await connectInjected();
      }
    } catch (err) {
      console.error('[KeyvraWallet] connect() failed:', err);
    } finally {
      state.connecting = false;
    }
  }

  async function disconnect() {
    try {
      if (state.mode === 'appkit' && appKitReady && appKit && typeof appKit.disconnect === 'function') {
        await appKit.disconnect();
      }
    } catch (err) {
      console.error('[KeyvraWallet] disconnect() failed:', err);
    }
    resetState();
    fireChange();
  }

  window.KeyvraWallet = {
    connect: connect,
    disconnect: disconnect,
    isConnected: function () { return !!state.connected; },
    getAddress: function () { return state.address; },
    getChainId: function () { return state.chainId; },
    getBalances: function () { return state.balances || {}; },
    formatBalance: function (value, symbol) {
      if (value === null || value === undefined || value === '') return '\u2014 ' + symbol;
      var num = Number(value);
      if (isNaN(num)) return '\u2014 ' + symbol;
      var decimals = (symbol === 'ETH') ? 4 : 2;
      return num.toFixed(decimals) + ' ' + symbol;
    }
  };

  // Attempt a silent reconnect for the injected fallback path on reload
  // (AppKit restores its own session internally via subscribeAccount above).
  (function trySilentInjectedReconnect() {
    var wasInjected;
    try { wasInjected = localStorage.getItem('keyvra_wallet_mode') === 'injected'; } catch (e) { wasInjected = false; }
    if (!wasInjected) return;
    setTimeout(function () {
      if (announcedProviders.length === 0 || state.connected) return;
      var provider = announcedProviders[0].provider;
      provider.request({ method: 'eth_accounts' }).then(function (accounts) {
        if (accounts && accounts.length) {
          state.address = accounts[0];
          state.injectedProvider = provider;
          state.mode = 'injected';
          state.connected = true;
          return provider.request({ method: 'eth_chainId' }).then(function (hex) {
            state.chainId = parseInt(hex, 16);
            refreshBalances();
            fireChange();
          });
        }
      }).catch(function () { /* silent — user just sees CONNECT WALLET */ });
    }, 300);
  })();
})();
