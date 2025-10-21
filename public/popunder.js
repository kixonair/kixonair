
(function(){
  var POPUNDER_URL = "https://crutchanalyse.com/mr7k9f8tn?key=3b77bcaeb297e078c0a853720cb4190f";
  var FLAG = "kx_popunder_shown";
  function once(fn){ var ran=false; return function(){ if(ran) return; ran=true; try{fn()}catch(_){}} };
  var fire = once(function(){
    try{ if(sessionStorage.getItem(FLAG)) return; }catch(_){}
    try{ window.open(POPUNDER_URL, "_blank", "noopener"); }catch(_){}
    try{ sessionStorage.setItem(FLAG,"1"); }catch(_){}
    try{ window.focus(); }catch(_){}
  });

  // Trigger on server button clicks (.sbtn)
  document.addEventListener("click", function(e){
    var t = e.target && e.target.closest ? e.target.closest(".sbtn") : null;
    if(!t) return;
    fire();
  }, true);
})();
