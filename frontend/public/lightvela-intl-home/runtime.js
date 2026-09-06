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
    if (!words.length) words = ['work partner', 'developer buddy', 'life concierge', 'financial assistant', 'plan executor', 'creative companion', 'content manager'];
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
    var shouldKeepNaturalText = window.matchMedia('(max-width: 640px), (prefers-reduced-motion: reduce)').matches;
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
    if (!shouldKeepNaturalText && main) next = splitChars(main, next);
    if (!shouldKeepNaturalText && prefix) next = splitChars(prefix, next + 60);
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
    var cards = Array.prototype.slice.call(document.querySelectorAll('.about__cards .wcard'));
    var strip = document.querySelector('.about__cards');
    if (!cards.length) return;
    var phoneMedia = window.matchMedia('(max-width: 640px)');
    function isPhone() {
      return phoneMedia.matches;
    }
    function mark(index) {
      if (!isPhone() || !cards[index]) return;
      cards.forEach(function (card, i) { card.classList.toggle('is-mobile-active', i === index); });
    }
    function activate(index, animate) {
      if (!isPhone() || !cards[index]) return;
      mark(index);
      try {
        cards[index].scrollIntoView({ behavior: animate ? 'smooth' : 'auto', inline: 'center', block: 'nearest' });
      } catch (_) {
        cards[index].scrollIntoView();
      }
    }
    cards.forEach(function (card, index) {
      card.addEventListener('click', function () { activate(index, true); });
    });
    if (strip) {
      var ticking = false;
      strip.addEventListener('scroll', function () {
        if (!isPhone() || ticking) return;
        ticking = true;
        requestAnimationFrame(function () {
          ticking = false;
          var stripBox = strip.getBoundingClientRect();
          var center = stripBox.left + stripBox.width / 2;
          var nearest = 0;
          var nearestDistance = Infinity;
          cards.forEach(function (card, index) {
            var box = card.getBoundingClientRect();
            var distance = Math.abs(box.left + box.width / 2 - center);
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearest = index;
            }
          });
          mark(nearest);
        });
      }, { passive: true });
    }
    activate(0, false);
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
      var phoneMedia = window.matchMedia('(max-width: 640px)');
      function isPhone() {
        return phoneMedia.matches;
      }
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
        if (isPhone() && subs[active]) {
          try {
            subs[active].scrollIntoView({ behavior: animate ? 'smooth' : 'auto', inline: 'center', block: 'nearest' });
          } catch (_) {
            subs[active].scrollIntoView();
          }
        }
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
      var touchRegion = scene.querySelector('.scene__chats');
      var touchStartX = 0;
      var touchStartY = 0;
      if (touchRegion) {
        touchRegion.addEventListener('touchstart', function (event) {
          var touch = event.changedTouches && event.changedTouches[0];
          if (!touch) return;
          touchStartX = touch.clientX;
          touchStartY = touch.clientY;
        }, { passive: true });
        touchRegion.addEventListener('touchend', function (event) {
          if (!isPhone()) return;
          var touch = event.changedTouches && event.changedTouches[0];
          if (!touch) return;
          var dx = touch.clientX - touchStartX;
          var dy = touch.clientY - touchStartY;
          if (Math.abs(dx) < 42 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
          var nextIndex = dx < 0 ? active + 1 : active - 1;
          if (nextIndex < 0) nextIndex = subs.length - 1;
          if (nextIndex >= subs.length) nextIndex = 0;
          render(nextIndex, true);
        }, { passive: true });
      }
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
  var labels = Array.prototype.slice.call(document.querySelectorAll('.plays__tabs label[for]'));
  if (!labels.length) return;
  var phoneMedia = window.matchMedia('(max-width: 640px)');
  function isPhone() {
    return phoneMedia.matches;
  }
  function getCheckedIndex() {
    var checked = document.querySelector('.plays input[type="radio"]:checked');
    return Math.max(0, labels.findIndex(function (label) {
      return checked && label.htmlFor === checked.id;
    }));
  }
  function activate(index) {
    if (!labels[index]) return;
    var input = document.getElementById(labels[index].htmlFor);
    if (input && !input.checked) input.click();
    if (isPhone()) {
      try {
        labels[index].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      } catch (_) {
        labels[index].scrollIntoView();
      }
    }
  }
  labels.forEach(function (label, i) {
    label.addEventListener('mouseenter', function () {
      activate(i);
    });
  });
  var stage = document.querySelector('.plays__stage');
  var startX = 0;
  var startY = 0;
  if (!stage) return;
  stage.addEventListener('touchstart', function (event) {
    var touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });
  stage.addEventListener('touchend', function (event) {
    if (!isPhone()) return;
    var touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;
    if (Math.abs(dx) < 42 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    var current = getCheckedIndex();
    var next = dx < 0 ? current + 1 : current - 1;
    if (next < 0) next = labels.length - 1;
    if (next >= labels.length) next = 0;
    activate(next);
  }, { passive: true });
})();
