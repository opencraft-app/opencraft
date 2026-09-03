/* Generated from the approved international homepage motion. */
(function () {
    var nav = document.querySelector('.nav');
    if (!nav) return;
    function update() {
      var t = Math.min(window.scrollY / (window.innerHeight * 0.2), 1);
      if (t <= 0) {
        nav.style.background = '';
        nav.style.backdropFilter = '';
        nav.style.webkitBackdropFilter = '';
        nav.style.borderBottomColor = '';
        return;
      }
      var eased = 1 - Math.pow(1 - t, 3);
      nav.style.background = 'rgba(255,255,255,' + (eased * 0.78).toFixed(3) + ')';
      nav.style.backdropFilter = 'blur(' + Math.round(eased * 18) + 'px) saturate(150%)';
      nav.style.webkitBackdropFilter = 'blur(' + Math.round(eased * 18) + 'px) saturate(150%)';
      nav.style.borderBottomColor = 'rgba(106, 79, 222,' + (eased * 0.08).toFixed(3) + ')';
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  })();

  (function () {
    var el = document.getElementById('hero-rotator');
    if (!el) return;
    var wrap = el.closest('.hero__rotator-wrap');
    var words = JSON.parse((el.closest('#lightvela-intl-home') || {}).dataset?.rotatorWords || '[]');
    if (!words.length) words = ['knowledge base', 'monitoring radar', 'reminder scheduler', 'business assistant', 'life concierge', 'work assistant'];
    var index = 0;
    var measurer = el.cloneNode(false);
    measurer.removeAttribute('id');
    measurer.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;white-space:nowrap;overflow:visible;';
    el.parentNode.appendChild(measurer);
    function measure(word) { measurer.textContent = word; return measurer.offsetWidth; }
    el.textContent = words[index];
    wrap.style.width = measure(words[index]) + 'px';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    function rotate() {
      index = (index + 1) % words.length;
      el.textContent = words[index];
      wrap.style.width = measure(words[index]) + 'px';
      setTimeout(rotate, 2200);
    }
    setTimeout(rotate, 2600);
  })();

  (function () {
    var INITIAL = 100;
    var STEP = 30;
    function splitChars(el, startDelay) {
      var text = el.textContent;
      el.textContent = '';
      for (var i = 0; i < text.length; i++) {
        var ch = document.createElement('span');
        ch.className = 'hero__char';
        ch.textContent = text[i] === ' ' ? '\u00a0' : text[i];
        ch.style.setProperty('--cd', (startDelay + i * STEP) + 'ms');
        el.appendChild(ch);
      }
      return startDelay + text.length * STEP;
    }
    var main = document.querySelector('.hero__line--main');
    var prefix = document.querySelector('.hero__line--dynamic .hero__prefix');
    var wrap = document.querySelector('.hero__line--dynamic .hero__rotator-wrap');
    var next = INITIAL;
    if (main) next = splitChars(main, next);
    if (prefix) next = splitChars(prefix, next + 60);
    if (wrap) wrap.style.setProperty('--rotator-delay', next + 'ms');
    var root = document.documentElement;
    var afterText = next + 200;
    root.style.setProperty('--cta-delay', afterText + 'ms');
    root.style.setProperty('--tabs-delay', (afterText + 160) + 'ms');
    root.style.setProperty('--frame-delay', (afterText + 320) + 'ms');
  })();

  (function () {
    var els = document.querySelectorAll('.sr');
    if (!els.length || typeof IntersectionObserver === 'undefined') {
      els.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (el) { io.observe(el); });
  })();

  (function () {
    var FADE_STEP = 80;
    function showStatic(thread) {
      if (!thread) return;
      thread.querySelectorAll('.bub').forEach(function (msg) {
        msg.classList.add('is-in', 'is-done');
        msg.classList.remove('is-typing');
        msg.querySelectorAll('p[data-full-html]').forEach(function (p) {
          p.innerHTML = p.dataset.fullHtml || '';
        });
      });
    }
    // 切换卡片时：气泡统一依次淡入（复用 .bub 的 is-in 过渡）
    function fadeInThread(thread) {
      if (!thread) return;
      var bubs = Array.prototype.slice.call(thread.querySelectorAll('.bub'));
      bubs.forEach(function (b) {
        b.classList.remove('is-in');
        b.style.transitionDelay = '0ms';
      });
      void thread.offsetWidth;
      bubs.forEach(function (b, i) {
        b.style.transitionDelay = (i * FADE_STEP) + 'ms';
        b.classList.add('is-in');
      });
    }

    document.querySelectorAll('.scene').forEach(function (scene) {
      var subs = Array.prototype.slice.call(scene.querySelectorAll('.scene__sub'));
      var chats = Array.prototype.slice.call(scene.querySelectorAll('.scene-chat'));
      if (!subs.length || !chats.length) return;
      var active = Math.max(0, subs.findIndex(function (btn) {
        return btn.classList.contains('on');
      }));
      function render(index, animate) {
        active = index;
        subs.forEach(function (btn, i) {
          btn.classList.toggle('on', i === active);
          btn.setAttribute('aria-pressed', i === active ? 'true' : 'false');
        });
        chats.forEach(function (chat, i) {
          chat.style.display = i === active ? '' : 'none';
          if (i === active) {
            var thread = chat.querySelector('.native__thread');
            showStatic(thread);
            if (animate) fadeInThread(thread);
          }
        });
      }
      subs.forEach(function (btn, i) {
        function activate() {
          if (active === i) return;
          render(i, true);
        }
        function activateFromKeyboard(event) {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activate();
        }
        btn.addEventListener('mouseenter', activate);
        btn.addEventListener('click', activate);
        btn.addEventListener('keydown', activateFromKeyboard);
      });
      render(active, false);

      // 顶部 tab 切换到本场景时，也让当前卡片的气泡依次淡入
      var radio = document.getElementById('sc-' + scene.id.replace('scene-', ''));
      if (radio) {
        radio.addEventListener('change', function () {
          if (!radio.checked) return;
          fadeInThread(chats[active].querySelector('.native__thread'));
        });
      }
    });
  })();

(function () {
    var chat = document.querySelector('#scene-3 .scene-chat');
    if (!chat) return;
    var answers = chat.querySelectorAll('.bub--ai .bub__box');
    if (answers.length < 2) return;
    var link = chat.querySelector('.line__link');
    var file = chat.querySelector('.line__file');
    if (!link || !file) return;
    var target = answers[answers.length - 1];
    target.appendChild(link);
    target.appendChild(file);
  })();

(function () {
  document.querySelectorAll('.plays__tabs label[for]').forEach(function (label) {
    label.addEventListener('mouseenter', function () {
      var input = document.getElementById(label.htmlFor);
      if (input && !input.checked) input.click();
    });
  });
})();
