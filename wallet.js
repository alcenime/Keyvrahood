/* ==========================================================
   KEYVRA â€” shared wallet state (demo only, no real chain calls)
   Persists across pages via localStorage so CONNECT WALLET on
   any page + DISCONNECT in the account menu stays in sync.
   ========================================================== */
(function(){
  var STORAGE_KEY = 'keyvraWallet';
  var DEMO_ADDRESS = '0x7A3F...42F1';

  function getWallet(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }
  function saveWallet(connected){
    try{
      if(connected){
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ connected:true, address:DEMO_ADDRESS }));
      }else{
        localStorage.removeItem(STORAGE_KEY);
      }
    }catch(e){}
  }
  function isConnected(){
    var w = getWallet();
    return !!(w && w.connected);
  }
  function getAddress(){
    var w = getWallet();
    return (w && w.address) || DEMO_ADDRESS;
  }

  function closeDropdownOnOutsideClick(dropdown, trigger){
    document.addEventListener('click', function handler(e){
      if(!dropdown.contains(e.target) && e.target !== trigger){
        dropdown.classList.remove('open');
      }
    });
  }

  function renderWalletArea(){
    var area = document.getElementById('walletArea');
    if(!area) return;

    if(isConnected()){
      area.innerHTML =
        '<div class="account-wrap">' +
          '<button class="wallet-btn" id="accountBtn" type="button">â–¤ ' + getAddress() + ' â–¾</button>' +
          '<div class="account-dropdown" id="accountDropdown">' +
            '<a href="profile.html">PROFILE</a>' +
            '<button class="disconnect" id="disconnectBtn" type="button">DISCONNECT</button>' +
          '</div>' +
        '</div>';

      var accountBtn = document.getElementById('accountBtn');
      var dropdown = document.getElementById('accountDropdown');
      var disconnectBtn = document.getElementById('disconnectBtn');

      accountBtn.addEventListener('click', function(e){
        e.stopPropagation();
        dropdown.classList.toggle('open');
      });
      closeDropdownOnOutsideClick(dropdown, accountBtn);
      disconnectBtn.addEventListener('click', function(){
        dropdown.classList.remove('open');
        disconnect();
      });
    }else{
      area.innerHTML = '<button class="wallet-btn" id="connectBtn" type="button">â–¤ CONNECT WALLET</button>';
      document.getElementById('connectBtn').addEventListener('click', function(){
        connect();
      });
    }
  }

  function connect(){
    saveWallet(true);
    renderWalletArea();
    if(typeof window.onWalletChange === 'function') window.onWalletChange(true);
    if(typeof window.showToast === 'function') window.showToast('Wallet connected');
  }

  function disconnect(){
    saveWallet(false);
    renderWalletArea();
    if(typeof window.onWalletChange === 'function') window.onWalletChange(false);
    if(typeof window.showToast === 'function') window.showToast('Wallet disconnected');
  }

  window.KeyvraWallet = {
    isConnected: isConnected,
    getAddress: getAddress,
    render: renderWalletArea,
    connect: connect,
    disconnect: disconnect
  };

  document.addEventListener('DOMContentLoaded', renderWalletArea);
})();
