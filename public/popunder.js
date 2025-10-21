(function(){
  var POPUNDER_URL = "https://crutchanalyse.com/mr7k9f8tn?key=3b77bcaeb297e078c0a853720cb4190f";
  var FLAG = "kx_popunder_shown";
  function maybeOpenPopunder(){
    try {
      if (sessionStorage.getItem(FLAG)) return;
      window.open(POPUNDER_URL, "_blank", "noopener");
      sessionStorage.setItem(FLAG, "1");
      try { window.focus(); } catch(e){}
    } catch(e){}
  }
  document.addEventListener("click", function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest(".sbtn");
    if (!btn) return;
    maybeOpenPopunder();
  }, true);
})();