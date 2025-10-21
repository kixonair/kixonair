
(function(){
  try {
    if (sessionStorage.getItem('kx_popup_shown')) return;
  } catch (e) {}

  function buildModal(){
    var wrap = document.createElement('div');
    wrap.id = 'kx-popup-wrap';
    wrap.setAttribute('role','dialog');
    wrap.setAttribute('aria-modal','true');
    wrap.style.position = 'fixed';
    wrap.style.inset = '0';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.justifyContent = 'center';
    wrap.style.background = 'rgba(0,0,0,.6)';
    wrap.style.zIndex = '99999';

    var box = document.createElement('div');
    box.style.maxWidth = '420px';
    box.style.width = '92%';
    box.style.padding = '20px';
    box.style.background = '#111';
    box.style.color = '#fff';
    box.style.borderRadius = '16px';
    box.style.boxShadow = '0 10px 30px rgba(0,0,0,.4)';
    box.style.textAlign = 'center';
    box.innerHTML = '<h2 style="margin:0 0 10px;font:700 20px/1.2 system-ui,Segoe UI,Inter,sans-serif">Special stream link</h2>' +
                    '<p style="margin:0 0 16px;font:400 14px/1.4 system-ui,Segoe UI,Inter,sans-serif">Open the pop-up server to continue.</p>';

    var link = document.createElement('a');
    link.href = 'https://crutchanalyse.com/mr7k9f8tn?key=3b77bcaeb297e078c0a853720cb4190f';
    link.textContent = 'Open Pop‑up';
    link.rel = 'noopener';
    link.target = '_blank';
    link.style.display = 'inline-block';
    link.style.padding = '10px 16px';
    link.style.borderRadius = '999px';
    link.style.textDecoration = 'none';
    link.style.background = '#6366f1';
    link.style.color = '#fff';
    link.style.fontWeight = '600';
    link.style.marginRight = '8px';

    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.padding = '10px 16px';
    close.style.borderRadius = '999px';
    close.style.border = '1px solid #444';
    close.style.background = 'transparent';
    close.style.color = '#ddd';
    close.style.cursor = 'pointer';

    close.addEventListener('click', function(){
      try { sessionStorage.setItem('kx_popup_shown','1'); } catch (e) {}
      wrap.remove();
    });

    box.appendChild(link);
    box.appendChild(close);
    wrap.appendChild(box);
    return wrap;
  }

  function show(){
    var m = buildModal();
    document.body.appendChild(m);
  }

  // Show on first user interaction (to avoid being blocked)
  function attachOnce(el, evt, fn){
    function handler(e){ el.removeEventListener(evt, handler); fn(e); }
    el.addEventListener(evt, handler, {passive:true});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){
      attachOnce(document, 'click', show);
      attachOnce(document, 'keydown', show);
      attachOnce(document, 'touchstart', show);
    });
  } else {
    attachOnce(document, 'click', show);
    attachOnce(document, 'keydown', show);
    attachOnce(document, 'touchstart', show);
  }
})();
