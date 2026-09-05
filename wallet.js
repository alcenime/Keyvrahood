from pathlib import Path

wallet_js = r"""/* KEYVRA — wallet.js
 * Real EVM wallet connection via Reown AppKit.
 * Network: Robinhood Chain (Chain ID 4663)
 */

(function () {
  'use strict';

  const PROJECT_ID = '126440cebeafcb400605e0ae20e9b55f';
  const CHAIN_ID = 4663;
  const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
  const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';
  const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

  let modal = null;
  let appKitReady = false;
  let currentAddress = null;
  let currentChainId = null;
  let currentProvider = null;
  let balances = { eth: 0n, usdg: 0n };

  const listeners = new Set();

  const robinhoodChain = {
    id: CHAIN_ID,
    name: 'Robinhood Chain',
    caipNetworkId: 'eip155:4663',
    chainNamespace: 'eip155',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18
    },
    rpcUrls: {
      default: { http: [RPC_URL] },
      public: { http: [RPC_URL] }
    },
    blockExplorers: {
      default: { name: 'Robinhood Chain Explorer', url: EXPLORER_URL }
    }
  };

  function shortAddress(address) {
    if (!address) return '';
    return address.slice(0, 6) + '...' + address.slice(-4);
  }

  function formatUnits(value, decimals, maxDecimals) {
    try {
      const negative = value < 0n;
      let v = negative ? -value : value;
      const base = 10n ** BigInt(decimals);
      const whole = v / base;
      const fraction = (v % base).toString().padStart(decimals, '0');
      let out = fraction.replace(/0+$/, '');
      if (maxDecimals != null) out = out.slice(0, maxDecimals).replace(/0+$/, '');
      return (negative ? '-' : '') + whole.toString() + (out ? '.' + out : '');
    } catch (_) {
      return '0';
    }
  }

  async function rpc(method, params) {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params: params || []
      })
    });

    if (!response.ok) throw new Error('Robinhood RPC request failed');
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'RPC error');
    return data.result;
  }

  async function loadBalances(address) {
    if (!address) {
      balances = { eth: 0n, usdg: 0n };
      return balances;
    }

    try {
      const ethHex = await rpc('eth_getBalance', [address, 'latest']);
      balances.eth = BigInt(ethHex);
    } catch (_) {
      balances.eth = 0n;
    }

    try {
      // USDG balanceOf(address)
      const selector = '0x70a08231';
      const paddedAddress = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const result = await rpc('eth_call', [
        { to: USDG_ADDRESS, data: selector + paddedAddress },
        'latest'
      ]);
      balances.usdg = BigInt(result || '0x0');
    } catch (_) {
      balances.usdg = 0n;
    }

    return balances;
  }

  function notify() {
    renderWalletArea();
    listeners.forEach(function (fn) {
      try { fn(); } catch (_) {}
    });

    if (typeof window.onWalletChange === 'function') {
      try { window.onWalletChange(); } catch (_) {}
    }
  }

  function renderWalletArea() {
    const area = document.getElementById('walletArea');
    if (!area) return;

    if (!currentAddress) {
      area.innerHTML =
        '<button class="wallet-btn" id="keyvraConnectBtn">CONNECT WALLET</button>';

      const btn = document.getElementById('keyvraConnectBtn');
      if (btn) {
        btn.addEventListener('click', function () {
          connect();
        });
      }
      return;
    }

    area.innerHTML =
      '<div class="account-wrap">' +
        '<button class="wallet-btn" id="keyvraAccountBtn">' +
          '● ' + shortAddress(currentAddress) +
        '</button>' +
        '<div class="account-dropdown" id="keyvraAccountDropdown">' +
          '<a href="profile.html">PROFILE</a>' +
          '<button type="button" id="keyvraCopyBtn">COPY ADDRESS</button>' +
          '<button type="button" id="keyvraDisconnectBtn" class="disconnect">DISCONNECT</button>' +
        '</div>' +
      '</div>';

    const accountBtn = document.getElementById('keyvraAccountBtn');
    const dropdown = document.getElementById('keyvraAccountDropdown');
    const copyBtn = document.getElementById('keyvraCopyBtn');
    const disconnectBtn = document.getElementById('keyvraDisconnectBtn');

    if (accountBtn && dropdown) {
      accountBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        dropdown.classList.toggle('open');
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        try {
          await navigator.clipboard.writeText(currentAddress);
          copyBtn.textContent = 'COPIED';
          setTimeout(function () { copyBtn.textContent = 'COPY ADDRESS'; }, 1200);
        } catch (_) {}
      });
    }

    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', function () {
        disconnect();
      });
    }
  }

  document.addEventListener('click', function () {
    document.querySelectorAll('.account-dropdown.open').forEach(function (el) {
      el.classList.remove('open');
    });
  });

  async function init() {
    if (appKitReady) return modal;

    try {
      // Reown AppKit supports EVM through its Ethers adapter.
      const appkit = await import(
        'https://esm.sh/@reown/appkit@1.8.23?bundle'
      );
      const ethersAdapterModule = await import(
        'https://esm.sh/@reown/appkit-adapter-ethers@1.8.23?bundle'
      );

      const createAppKit = appkit.createAppKit;
      const EthersAdapter = ethersAdapterModule.EthersAdapter;

      if (!createAppKit || !EthersAdapter) {
        throw new Error('Reown AppKit modules failed to load.');
      }

      const metadata = {
        name: 'KEYVRA',
        description: 'KEYVRA staking protocol on Robinhood Chain',
        url: window.location.origin,
        icons: []
      };

      modal = createAppKit({
        adapters: [new EthersAdapter()],
        networks: [robinhoodChain],
        defaultNetwork: robinhoodChain,
        projectId: PROJECT_ID,
        metadata: metadata,
        features: {
          analytics: true,
          email: false,
          socials: []
        },
        enableNetworkSwitch: true,
        enableReconnect: true,
        enableMobileFullScreen: true,
        customRpcUrls: {
          'eip155:4663': [{ url: RPC_URL }]
        }
      });

      appKitReady = true;

      modal.subscribeProvider(function (state) {
        currentAddress = state && state.address ? state.address : null;
        currentChainId = state && state.chainId ? Number(state.chainId) : null;
        currentProvider = state && state.provider ? state.provider : null;

        if (!currentAddress && modal.getIsConnected && modal.getIsConnected()) {
          currentAddress = modal.getAddress ? modal.getAddress() : null;
        }

        if (currentAddress) {
          loadBalances(currentAddress).finally(notify);
        } else {
          balances = { eth: 0n, usdg: 0n };
          notify();
        }
      });

      // Restore an existing AppKit session if one exists.
      if (modal.getIsConnected && modal.getIsConnected()) {
        currentAddress = modal.getAddress ? modal.getAddress() : null;
        currentChainId = modal.getChainId ? Number(modal.getChainId()) : null;
        currentProvider = modal.getWalletProvider ? modal.getWalletProvider() : null;

        if (currentAddress) {
          await loadBalances(currentAddress);
        }
      }

      notify();
      return modal;
    } catch (error) {
      console.error('[KEYVRA] Reown initialization failed:', error);
      appKitReady = false;
      throw error;
    }
  }

  async function connect() {
    try {
      if (!appKitReady) await init();
      if (!modal) throw new Error('Wallet modal is not ready.');

      // Explicitly open the EVM wallet selection view.
      modal.open({ view: 'Connect', namespace: 'eip155' });
    } catch (error) {
      console.error('[KEYVRA] Wallet connection failed:', error);
      alert('Unable to load the wallet connection. Please refresh and try again.');
    }
  }

  async function disconnect() {
    try {
      if (!modal) return;
      if (modal.adapter &&
          modal.adapter.connectionControllerClient &&
          modal.adapter.connectionControllerClient.disconnect) {
        await modal.adapter.connectionControllerClient.disconnect();
      }
    } catch (error) {
      console.error('[KEYVRA] Disconnect failed:', error);
    } finally {
      currentAddress = null;
      currentChainId = null;
      currentProvider = null;
      balances = { eth: 0n, usdg: 0n };
      notify();
    }
  }

  function isConnected() {
    return !!currentAddress;
  }

  function getAddress() {
    return currentAddress || '';
  }

  function getChainId() {
    return currentChainId;
  }

  function getProvider() {
    return currentProvider || (modal && modal.getWalletProvider
      ? modal.getWalletProvider()
      : null);
  }

  function getBalances() {
    return {
      eth: balances.eth,
      usdg: balances.usdg
    };
  }

  function formatBalance(value, symbol) {
    if (value == null) return '— ' + symbol;

    try {
      const raw = typeof value === 'bigint' ? value : BigInt(value);
      const decimals = symbol === 'USDG' ? 18 : 18;
      const formatted = formatUnits(raw, decimals, 6);
      return formatted + ' ' + symbol;
    } catch (_) {
      return '0 ' + symbol;
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  window.KeyvraWallet = {
    init: init,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    getAddress: getAddress,
    getChainId: getChainId,
    getProvider: getProvider,
    getWalletProvider: getProvider,
    getBalances: getBalances,
    formatBalance: formatBalance,
    onChange: onChange,
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    usdgAddress: USDG_ADDRESS
  };

  // Start AppKit immediately, but never block the page if it fails.
  renderWalletArea();
  init().catch(function (error) {
    console.error('[KEYVRA] AppKit startup error:', error);
    renderWalletArea();
  });
})();
"""

path = Path("/mnt/data/wallet.js")
path.write_text(wallet_js, encoding="utf-8")
print(f"Created {path} ({path.stat().st_size} bytes)")

