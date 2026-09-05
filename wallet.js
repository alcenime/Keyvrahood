/* KEYVRA â€” real wallet connection (Robinhood Chain)
   No mock data. Uses window.ethereum (EIP-1193) directly for all reads/writes.
   KEYVRA token balance intentionally not read yet (token not launched / no contract address).
*/
(function () {
  'use strict';

  // ---- Official Robinhood Chain config ----
  var CHAIN_ID_DEC = 4663;
  var CHAIN_ID_HEX = '0x' + CHAIN_ID_DEC.toString(16); // 0x1237
  var CHAIN_PARAMS = {
    chainId: CHAIN_ID_HEX,
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com']
  };
  var USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

  var state = {
    address: null,
    chainId: null,
    connecting: false,
    balances: { eth: null, usdg: null }
  };

  function short(addr) {
    return addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : '';
  }

  function notify() {
    render();
    if (typeof window.onWalletChange === 'function') {
      try { window.onWalletChange(); } catch (e) { console.error(e); }
    }
  }

  // ---------------------------------------------------------------
  // Minimal raw JSON-RPC ERC20 reads (no external lib dependency)
  // ---------------------------------------------------------------
  function padAddress(addr) {
    return addr.toLowerCase().replace('0x', '').padStart(64, '0');
  }
  function hexToBigInt(hex) {
    if (!hex || hex === '0x') return 0n;
    return BigInt(hex);
  }
  function formatUnits(bi, decimals) {
    var neg = bi < 0n;
    if (neg) bi = -bi;
    var s = bi.toString().padStart(decimals + 1, '0');
    var whole = s.slice(0, s.length - decimals) || '0';
    var frac = s.slice(s.length - decimals).replace(/0+$/, '');
    var out = frac ? whole + '.' + frac : whole;
    return (neg ? '-' : '') + out;
  }
  function ethCall(to, data) {
    return window.ethereum.request({
      method: 'eth_call',
      params: [{ to: to, data: data }, 'latest']
    });
  }
  function erc20Decimals(token) {
    return ethCall(token, '0x313ce567') // decimals()
      .then(function (res) { return parseInt(res, 16); })
      .catch(function () { return 18; });
  }
  function erc20BalanceOf(token, owner) {
    var data = '0x70a08231' + padAddress(owner); // balanceOf(address)
    return ethCall(token, data).then(hexToBigInt);
  }

  function refreshBalances() {
    if (!state.address || state.chainId !== CHAIN_ID_HEX) return Promise.resolve();

    var ethP = window.ethereum
      .request({ method: 'eth_getBalance', params: [state.address, 'latest'] })
      .then(function (hex) { state.balances.eth = formatUnits(hexToBigInt(hex), 18); })
      .catch(function (e) { console.error('ETH balance read failed', e); });

    var usdgP = erc20Decimals(USDG_ADDRESS)
      .then(function (dec) {
        return erc20BalanceOf(USDG_ADDRESS, state.address).then(function (bal) {
          state.balances.usdg = formatUnits(bal, dec);
        });
      })
      .catch(function (e) { console.error('USDG balance read failed', e); });

    return Promise.all([ethP, usdgP]).then(notify);
  }

  // ---------------------------------------------------------------
  // Chain detect / switch / add
  // ---------------------------------------------------------------
  function ensureChain() {
    return window.ethereum.request({ method: 'eth_chainId' }).then(function (current) {
      state.chainId = current;
      if (current === CHAIN_ID_HEX) return true;

      return window.ethereum
        .request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_ID_HEX }]
        })
        .then(function () {
          state.chainId = CHAIN_ID_HEX;
          return true;
        })
        .catch(function (switchErr) {
          // 4902 = chain not added to wallet yet
          if (switchErr && switchErr.code === 4902) {
            return window.ethereum
              .request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS] })
              .then(function () {
                state.chainId = CHAIN_ID_HEX;
                return true;
              })
              .catch(function (addErr) {
                console.error('Add Robinhood Chain failed', addErr);
                return false;
              });
          }
          console.error('Switch to Robinhood Chain failed', switchErr);
          return false;
        });
    });
  }

  // ---------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------
  function connect() {
    if (!window.ethereum) {
      alert('No EVM wallet found. Please install MetaMask (or another browser wallet) to connect.');
      return Promise.resolve();
    }
    if (state.connecting) return Promise.resolve();
    state.connecting = true;
    render();

    return window.ethereum
      .request({ method: 'eth_requestAccounts' })
      .then(function (accounts) {
        state.address = (accounts && accounts[0]) || null;
        return ensureChain();
      })
      .then(function () {
        state.connecting = false;
        notify();
        return refreshBalances();
      })
      .catch(function (e) {
        state.connecting = false;
        render();
        console.error('Wallet connection rejected/failed', e);
      });
  }

  function disconnect() {
    // EIP-1193 has no true "revoke" call for most wallets â€” this clears local session state.
    state.address = null;
    state.chainId = null;
    state.balances = { eth: null, usdg: null };
    notify();
  }

  // ---------------------------------------------------------------
  // Provider events
  // ---------------------------------------------------------------
  function bindProviderEvents() {
    if (!window.ethereum || !window.ethereum.on) return;

    window.ethereum.on('accountsChanged', function (accounts) {
      state.address = accounts && accounts[0] ? accounts[0] : null;
      if (!state.address) {
        disconnect();
        return;
      }
      refreshBalances();
      notify();
    });

    window.ethereum.on('chainChanged', function (chainId) {
      state.chainId = chainId;
      notify();
      if (chainId === CHAIN_ID_HEX) refreshBalances();
    });
  }

  function checkExistingConnection() {
    if (!window.ethereum) {
      render();
      return;
    }
    window.ethereum
      .request({ method: 'eth_accounts' })
      .then(function (accounts) {
        if (!accounts || !accounts[0]) {
          render();
          return;
        }
        state.address = accounts[0];
        return window.ethereum.request({ method: 'eth_chainId' }).then(function (chainId) {
          state.chainId = chainId;
          notify();
          return refreshBalances();
        });
      })
      .catch(function () { render(); });
  }

  // ---------------------------------------------------------------
  // UI â€” renders into <div id="walletArea"> using the site's existing
  // .wallet-btn / .account-wrap / .account-dropdown styles (unchanged CSS)
  // ---------------------------------------------------------------
  function render() {
    var area = document.getElementById('walletArea');
    if (!area) return;

    if (!state.address) {
      area.innerHTML =
        '<button class="wallet-btn" id="kvConnectBtn">' +
        (state.connecting ? 'CONNECTING\u2026' : 'CONNECT WALLET') +
        '</button>';
      var btn = document.getElementById('kvConnectBtn');
      if (btn) btn.addEventListener('click', connect);
      return;
    }

    var wrongNet = state.chainId && state.chainId !== CHAIN_ID_HEX;
    area.innerHTML =
      '<div class="account-wrap">' +
      '<button class="wallet-btn" id="kvAcctBtn">' +
      (wrongNet ? 'WRONG NETWORK \u26A0' : short(state.address)) +
      '</button>' +
      '<div class="account-dropdown" id="kvAcctDropdown">' +
      '<a href="profile.html">PROFILE</a>' +
      (wrongNet ? '<button id="kvSwitchBtn">SWITCH NETWORK</button>' : '') +
      '<button class="disconnect" id="kvDisconnectBtn">DISCONNECT</button>' +
      '</div>' +
      '</div>';

    var acctBtn = document.getElementById('kvAcctBtn');
    var dropdown = document.getElementById('kvAcctDropdown');
    if (acctBtn && dropdown) {
      acctBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        dropdown.classList.toggle('open');
      });
      document.addEventListener('click', function () {
        dropdown.classList.remove('open');
      });
    }
    var switchBtn = document.getElementById('kvSwitchBtn');
    if (switchBtn) {
      switchBtn.addEventListener('click', function () {
        ensureChain().then(function () {
          notify();
          refreshBalances();
        });
      });
    }
    var discBtn = document.getElementById('kvDisconnectBtn');
    if (discBtn) discBtn.addEventListener('click', disconnect);
  }

  // ---------------------------------------------------------------
  // Public API (kept compatible with existing page scripts)
  // ---------------------------------------------------------------
  window.KeyvraWallet = {
    connect: connect,
    disconnect: disconnect,
    isConnected: function () { return !!state.address; },
    getAddress: function () { return state.address; },
    getChainId: function () { return state.chainId; },
    isCorrectChain: function () { return state.chainId === CHAIN_ID_HEX; },
    getBalances: function () { return { eth: state.balances.eth, usdg: state.balances.usdg }; },
    formatBalance: function (value, symbol) {
      if (value === null || value === undefined) return '\u2014 ' + symbol;
      var num = parseFloat(value);
      var display = isNaN(num) ? value : num.toLocaleString(undefined, { maximumFractionDigits: 4 });
      return display + ' ' + symbol;
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    render();
    bindProviderEvents();
    checkExistingConnection();
  });
})();
