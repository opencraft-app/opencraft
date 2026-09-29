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
    if (!words.length) words = ['work partner', 'developer buddy', 'plan executor', 'market watcher', 'life concierge', 'financial assistant', 'creative companion', 'content manager'];
    var index = 0;
    el.textContent = words[index];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var rotateTimer = 0;
    var changeTimer = 0;
    var sweepTimer = 0;
    var sweepFrame = 0;
    var initialRotationPending = true;
    var rotatorVisible = !document.hidden;
    if (typeof IntersectionObserver !== 'undefined') {
      var rotatorObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.target === wrap) rotatorVisible = entry.isIntersecting && !document.hidden;
        });
      }, { threshold: 0.01 });
      rotatorObserver.observe(wrap);
    }
    function applyWord(word) {
      el.textContent = word;
      el.setAttribute('data-word', word);
    }
    applyWord(words[index]);
    function scheduleRotate(delay) {
      window.clearTimeout(rotateTimer);
      rotateTimer = window.setTimeout(rotate, delay);
    }
    function sweepToWord(word) {
      window.clearTimeout(changeTimer);
      window.clearTimeout(sweepTimer);
      window.cancelAnimationFrame(sweepFrame);
      wrap.classList.remove('is-sweeping');
      sweepFrame = window.requestAnimationFrame(function () {
        wrap.classList.add('is-sweeping');
      });
      changeTimer = window.setTimeout(function () { applyWord(word); }, 260);
      sweepTimer = window.setTimeout(function () { wrap.classList.remove('is-sweeping'); }, 680);
    }
    function rotate() {
      if (!rotatorVisible) {
        scheduleRotate(900);
        return;
      }
      initialRotationPending = false;
      index = (index + 1) % words.length;
      sweepToWord(words[index]);
      scheduleRotate(2200);
    }
    document.addEventListener('visibilitychange', function () {
      rotatorVisible = !document.hidden;
      if (rotatorVisible) {
        applyWord(words[index]);
        if (!initialRotationPending) scheduleRotate(420);
      }
    });
    window.addEventListener('pageshow', function () {
      rotatorVisible = !document.hidden;
      applyWord(words[index]);
      if (!initialRotationPending) scheduleRotate(520);
    });
    window.setTimeout(function () {
      var revealDelay = parseInt(wrap.style.getPropertyValue('--rotator-delay'), 10) || 0;
      scheduleRotate(revealDelay + 2200);
    }, 0);
  })();

  (function () {
    var INITIAL = 100;
    var STEP = 30;
    var CHAR_DURATION = 500;
    var SEGMENT_GAP = 80;
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
      return startDelay + Math.max(0, text.length - 1) * STEP + CHAR_DURATION;
    }
    var main = document.querySelector('.hero__line--main');
    var prefix = document.querySelector('.hero__line--dynamic .hero__prefix');
    var wrap = document.querySelector('.hero__line--dynamic .hero__rotator-wrap');
    var suffix = document.querySelector('.hero__line--dynamic .hero__suffix');
    var next = INITIAL;
    if (!shouldKeepNaturalText && main) next = splitChars(main, next);
    if (!shouldKeepNaturalText && prefix) next = splitChars(prefix, next + SEGMENT_GAP);
    var rotatorDelay = shouldKeepNaturalText ? 0 : next + SEGMENT_GAP;
    if (wrap) wrap.style.setProperty('--rotator-delay', rotatorDelay + 'ms');
    if (suffix) suffix.style.setProperty('--rotator-delay', rotatorDelay + 'ms');
    var root = document.documentElement;
    var afterText = rotatorDelay + (shouldKeepNaturalText ? 0 : 600) + 200;
    root.style.setProperty('--cta-delay', afterText + 'ms');
    root.style.setProperty('--tabs-delay', (afterText + 160) + 'ms');
    root.style.setProperty('--frame-delay', (afterText + 320) + 'ms');
    root.classList.add('hero-sequence-ready');
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
  var voice = document.querySelector('#lightvela-intl-home .voice');
  if (!voice || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var rows = Array.prototype.slice.call(voice.querySelectorAll('.mrow'));
  if (!rows.length) return;
  rows.forEach(function (row) {
    var track = row.querySelector('.mrow__track');
    if (track) track.style.animation = 'none';
  });
  var voiceFrame = 0;
  var isActive = false;
  function renderVoiceMotion() {
    voiceFrame = 0;
    var rect = voice.getBoundingClientRect();
    var viewport = window.innerHeight || document.documentElement.clientHeight || 1;
    var progress = (viewport - rect.top) / (viewport + rect.height);
    var clamped = Math.max(0, Math.min(1, progress));
    var measurements = rows.map(function (row) {
      var track = row.querySelector('.mrow__track');
      if (!track) return null;
      return {
        track: track,
        maxOffset: Math.max(0, track.scrollWidth - row.clientWidth),
        reverse: row.classList.contains('mrow--r')
      };
    });
    measurements.forEach(function (measurement) {
      if (!measurement) return;
      var offset = measurement.reverse
        ? (-measurement.maxOffset + clamped * measurement.maxOffset).toFixed(2)
        : (-clamped * measurement.maxOffset).toFixed(2);
      measurement.track.style.transform = 'translate3d(' + offset + 'px, 0, 0)';
    });
  }
  function requestVoiceMotion() {
    if (!isActive || voiceFrame) return;
    voiceFrame = window.requestAnimationFrame(renderVoiceMotion);
  }
  function startVoiceMotion() {
    if (isActive) return;
    isActive = true;
    window.addEventListener('scroll', requestVoiceMotion, { passive: true });
    window.addEventListener('resize', requestVoiceMotion);
    requestVoiceMotion();
  }
  function stopVoiceMotion() {
    if (!isActive) return;
    isActive = false;
    window.removeEventListener('scroll', requestVoiceMotion);
    window.removeEventListener('resize', requestVoiceMotion);
    if (voiceFrame) {
      window.cancelAnimationFrame(voiceFrame);
      voiceFrame = 0;
    }
  }
  if (typeof IntersectionObserver === 'undefined') {
    startVoiceMotion();
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) startVoiceMotion();
      else stopVoiceMotion();
    });
  }, { rootMargin: '120px 0px', threshold: 0 });
  observer.observe(voice);
})();

(function () {
  var labels = Array.prototype.slice.call(document.querySelectorAll('.plays__tabs label[for]'));
  var plays = document.querySelector('.plays');
  var stage = document.querySelector('.plays__stage');
  if (!labels.length || !plays || !stage) return;
  var phoneMedia = window.matchMedia('(max-width: 640px)');
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var timer = 0;
  var readable = false;
  var manualSelection = false;
  var pointerInside = false;
  var advancing = false;
  var disposed = false;
  function getCheckedIndex() {
    var checked = plays.querySelector('input[type="radio"]:checked');
    return Math.max(0, labels.findIndex(function (label) {
      return checked && label.htmlFor === checked.id;
    }));
  }
  function stopTimer() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  }
  function schedule() {
    stopTimer();
    if (disposed || !readable || manualSelection || pointerInside || phoneMedia.matches ||
        reducedMotion.matches || document.hidden || plays.contains(document.activeElement)) return;
    timer = window.setTimeout(function () {
      timer = 0;
      if (!plays.isConnected) { dispose(); return; }
      advancing = true;
      var next = (getCheckedIndex() + 1) % labels.length;
      document.getElementById(labels[next].htmlFor).click();
      advancing = false;
      schedule();
    }, 8000);
  }
  function showTab(index) {
    manualSelection = true;
    stopTimer();
    var input = document.getElementById(labels[index].htmlFor);
    if (input && !input.checked) input.click();
    // Only move the horizontal tab strip; never scroll the document during a swipe.
    if (phoneMedia.matches) {
      var tabs = labels[index].parentElement;
      var tabRect = labels[index].getBoundingClientRect();
      var tabsRect = tabs.getBoundingClientRect();
      if (tabs.scrollTo) tabs.scrollTo({
        left: tabs.scrollLeft + tabRect.left - tabsRect.left - (tabsRect.width - tabRect.width) / 2,
        behavior: reducedMotion.matches ? 'auto' : 'smooth'
      });
    }
  }
  labels.forEach(function (label, index) {
    label.addEventListener('mouseenter', function () {
      if (!phoneMedia.matches) showTab(index);
    });
    label.addEventListener('click', function () { showTab(index); });
  });
  plays.addEventListener('change', function (event) {
    if (advancing || !event.target.matches('input[type="radio"]')) return;
    manualSelection = true;
    stopTimer();
  });
  plays.addEventListener('mouseenter', function () { pointerInside = true; stopTimer(); });
  plays.addEventListener('mouseleave', function () { pointerInside = false; schedule(); });
  plays.addEventListener('focusin', stopTimer);
  plays.addEventListener('focusout', schedule);
  var startX = 0;
  var startY = 0;
  stage.addEventListener('touchstart', function (event) {
    var touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });
  stage.addEventListener('touchend', function (event) {
    if (!phoneMedia.matches) return;
    var touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;
    if (Math.abs(dx) < 42 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    showTab((getCheckedIndex() + (dx < 0 ? 1 : labels.length - 1)) % labels.length);
  }, { passive: true });
  if (typeof IntersectionObserver === 'undefined') return;
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!plays.isConnected) { dispose(); return; }
      readable = entry.isIntersecting && entry.intersectionRatio >= 0.75;
      if (!entry.isIntersecting) manualSelection = false;
      schedule();
    });
  }, { threshold: [0, 0.75], rootMargin: '-64px 0px 0px 0px' });
  observer.observe(stage);
  document.addEventListener('visibilitychange', schedule);
  phoneMedia.addEventListener('change', schedule);
  reducedMotion.addEventListener('change', schedule);
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopTimer();
    observer.disconnect();
    document.removeEventListener('visibilitychange', schedule);
    phoneMedia.removeEventListener('change', schedule);
    reducedMotion.removeEventListener('change', schedule);
  }
  document.addEventListener('lightvela-home-dispose', dispose, { once: true });
})();

/* 国际站能力卡动效：静止停在完成帧 → 进入视口播一次 → 桌面 Hover 重播关键变化。
   状态机：idle → playing → complete；Hover 时 complete → playing → complete。
   已经开始播放的卡片重复 Hover 不会重启；移动端同一时间只播一张。 */
(function () {
  var root = document.getElementById("lightvela-intl-home");
  if (!root) return;
  var section = root.querySelector(".about");
  var cards = Array.prototype.slice.call(root.querySelectorAll(".about__cards .wcard"));
  if (!section || !cards.length || !("IntersectionObserver" in window)) return;

  var MOTION_IDLE = "idle";
  var MOTION_PLAYING = "playing";
  var MOTION_COMPLETE = "complete";
  var CLASS_PLAYING = "is-playing";
  var CLASS_REPLAY = "is-replay";
  var disposed = false;
  var timers = [];
  var setTimer = function (callback, delay) {
    var timer = window.setTimeout(function () {
      timers = timers.filter(function (activeTimer) { return activeTimer !== timer; });
      if (!disposed) callback();
    }, delay);
    timers.push(timer);
    return timer;
  };
  var clearTimer = function (timer) {
    window.clearTimeout(timer);
    timers = timers.filter(function (activeTimer) { return activeTimer !== timer; });
  };
  var clearAllTimers = function () {
    timers.forEach(function (timer) { window.clearTimeout(timer); });
    timers = [];
  };
  var mq = function (query) {
    return window.matchMedia ? window.matchMedia(query) : null;
  };
  var isReduced = function () {
    var m = mq("(prefers-reduced-motion: reduce)");
    return !!(m && m.matches);
  };
  var isFinePointer = function () {
    var m = mq("(hover: hover) and (pointer: fine)");
    return !!(m && m.matches);
  };
  var isPhone = function () {
    var m = mq("(max-width: 640px)");
    return !!(m && m.matches);
  };

  var demoOf = function (card) {
    return card.querySelector(".wcard__demo");
  };
  var attrNumber = function (element, name, fallback) {
    var value = parseInt(element.getAttribute(name), 10);
    return isNaN(value) ? fallback : value;
  };

  var settle = function (card, delay) {
    setTimer(function () {
      var demo = demoOf(card);
      if (demo) demo.classList.remove(CLASS_PLAYING);
      if (demo) demo.classList.remove(CLASS_REPLAY);
      var stage = demo && demo.firstElementChild;
      if (stage) stage.classList.remove(CLASS_PLAYING);
      if (stage) stage.classList.remove(CLASS_REPLAY);
      card.setAttribute("data-motion", MOTION_COMPLETE);
      if (!isPhone() && sectionVisible) scheduleLoop(card);
    }, delay);
  };

  /* 定时任务卡：每个 case 到达时间点后，只让最后一条通知逐字打出。
     动画由 case 自己的 15s 周期驱动，避免卡片重播状态与三组 case 相位互相覆盖。 */
  var AUT_DELIVERY_DELAY = 0;
  var AUT_TYPE_SPEED = 32;
  var AUT_HOLDER = "\u200b"; /* 零宽空格：清空后仍保留行高，气泡不塌陷 */
  var autTimers = [];
  var autFirstCycleQueued = false;
  var autCases = Array.prototype.slice.call(
    root.querySelectorAll(".wcard__demo--auto .aut__case")
  );
  /* The first visible automation case is already on screen when the section
     enters view; later cases type from their animation cycle callbacks. */
  var initialAutCase = autCases[0];
  var autDeliveries = Array.prototype.slice.call(
    root.querySelectorAll(".wcard__demo--auto .aut__bubble--delivery span")
  );
  autDeliveries.forEach(function (span) {
    span.setAttribute("data-aut-text", span.textContent);
  });
  var restoreAutTexts = function () {
    autDeliveries.forEach(function (span) {
      var text = span.getAttribute("data-aut-text") || "";
      if (span.textContent !== text) span.textContent = text;
      span.classList.remove("is-typing");
    });
  };
  var autAnimated = function () {
    return autDeliveries.length > 0 && !isReduced();
  };
  var clearAutTimers = function () {
    autTimers.forEach(function (timer) { window.clearTimeout(timer); });
    autTimers = [];
  };
  var typeAutDelivery = function (caseElement) {
    if (!autAnimated()) return;
    var span = caseElement.querySelector(".aut__bubble--delivery span");
    if (!span) return;
    var run = parseInt(span.getAttribute("data-aut-run") || "0", 10) + 1;
    span.setAttribute("data-aut-run", String(run));
    span.textContent = AUT_HOLDER;
    autTimers.push(window.setTimeout(function () {
      if (disposed) return;
      var text = span.getAttribute("data-aut-text") || "";
      if (!text) return;
      var index = 1;
      span.classList.add("is-typing");
      span.textContent = text.slice(0, index);
      var step = function () {
        if (disposed) return;
        if (parseInt(span.getAttribute("data-aut-run") || "0", 10) !== run) return;
        index += 1;
        span.textContent = text.slice(0, index);
        if (index < text.length) {
          autTimers.push(window.setTimeout(step, AUT_TYPE_SPEED));
        } else {
          span.classList.remove("is-typing");
        }
      };
      step();
    }, AUT_DELIVERY_DELAY));
  };
  var onAutCaseCycle = function (event) {
    if (event.target !== event.currentTarget || event.animationName !== "aut-case-cycle") return;
    typeAutDelivery(event.currentTarget);
  };
  autCases.forEach(function (caseElement) {
    caseElement.addEventListener("animationstart", onAutCaseCycle);
    caseElement.addEventListener("animationiteration", onAutCaseCycle);
  });
  /* Keep full copy as the fallback. If animationstart fires before this listener
     is attached, the next visible case still shows content instead of an empty
     LightVela bubble. The active case is cleared only when typing is scheduled. */
  var onResize = function () {
    if (!autAnimated()) {
      clearAutTimers();
      restoreAutTexts();
    }
  };
  window.addEventListener("resize", onResize);

  var sectionVisible = false;
  var loopTimers = [];
  var scheduleLoop = function (card) {
    var index = cards.indexOf(card);
    clearTimer(loopTimers[index]);
    loopTimers[index] = setTimer(function () {
      if (sectionVisible && card.getAttribute("data-motion") === MOTION_COMPLETE) replay(card);
    }, 1300 + index * 180);
  };

  /* idle → playing → complete，播完回到完成帧（静止首帧即完成帧） */
  var play = function (card) {
    if (card.getAttribute("data-motion") === MOTION_PLAYING) return;
    var demo = demoOf(card);
    if (!demo) return;
    if (isReduced()) {
      card.setAttribute("data-motion", MOTION_COMPLETE);
      return;
    }
    card.setAttribute("data-motion", MOTION_PLAYING);
    demo.classList.remove(CLASS_REPLAY);
    demo.classList.add(CLASS_PLAYING);
    var stage = demo.firstElementChild;
    if (stage) stage.classList.remove(CLASS_REPLAY);
    if (stage) stage.classList.add(CLASS_PLAYING);
    settle(card, attrNumber(demo, "data-dur", 2600) + 80);
  };

  /* Hover：complete → playing → complete，只重播关键变化 */
  var replay = function (card) {
    if (card.getAttribute("data-motion") !== MOTION_COMPLETE) return;
    var demo = demoOf(card);
    if (!demo || isReduced()) return;
    card.setAttribute("data-motion", MOTION_PLAYING);
    demo.classList.remove(CLASS_REPLAY);
    var stage = demo.firstElementChild;
    if (stage) stage.classList.remove(CLASS_REPLAY);
    void demo.offsetWidth;
    demo.classList.add(CLASS_REPLAY);
    if (stage) stage.classList.add(CLASS_REPLAY);
    settle(card, attrNumber(demo, "data-replay", 1600) + 80);
  };

  var revealHead = function () {
    var head = section.querySelector(".about__head");
    if (head) head.classList.add("is-in");
  };

  var sectionObserver;
  var visibilityObserver;
  var cardObserver;
  var hoverListeners = [];
  var dispose = function () {
    disposed = true;
    clearAllTimers();
    clearAutTimers();
    restoreAutTexts();
    autCases.forEach(function (caseElement) {
      caseElement.removeEventListener("animationstart", onAutCaseCycle);
      caseElement.removeEventListener("animationiteration", onAutCaseCycle);
    });
    window.removeEventListener("resize", onResize);
    if (sectionObserver) sectionObserver.disconnect();
    if (visibilityObserver) visibilityObserver.disconnect();
    if (cardObserver) cardObserver.disconnect();
    hoverListeners.forEach(function (listener) {
      listener.card.removeEventListener("mouseenter", listener.enter);
      listener.card.removeEventListener("focusin", listener.focus);
    });
    hoverListeners = [];
    document.removeEventListener("lightvela-home-dispose", dispose);
  };
  document.addEventListener("lightvela-home-dispose", dispose, { once: true });

  /* JS 接管后才允许标题 / 卡片有初始位移，避免脚本失效时内容不可见 */
  section.classList.add("is-motion");
  cards.forEach(function (card) {
    card.setAttribute("data-motion", MOTION_IDLE);
  });

  if (isReduced()) {
    revealHead();
    cards.forEach(function (card) {
      card.classList.add("is-in");
      card.setAttribute("data-motion", MOTION_COMPLETE);
    });
    return;
  }

  /* 桌面：整块进入视口 40% 后，标题淡入、卡片间隔 70ms 依次播一次 */
  sectionObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.4) return;
        sectionObserver.disconnect();
        revealHead();
        cards.forEach(function (card, index) {
          setTimer(function () {
            card.classList.add("is-in");
            if (!isPhone()) play(card);
          }, index * 70);
        });
      });
    },
    { threshold: [0.4] },
  );
  sectionObserver.observe(section);

  visibilityObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      sectionVisible = entry.isIntersecting && entry.intersectionRatio >= 0.08;
      section.classList.toggle("is-visible", sectionVisible);
      if (sectionVisible && !autFirstCycleQueued && autAnimated() && initialAutCase) {
        autFirstCycleQueued = true;
        typeAutDelivery(initialAutCase);
      }
      if (!sectionVisible || isPhone()) return;
      cards.forEach(function (card) {
        if (card.getAttribute("data-motion") === MOTION_COMPLETE) scheduleLoop(card);
      });
    });
  }, { threshold: [0, 0.08] });
  visibilityObserver.observe(section);

  /* 移动端：单卡进入视口 60% 时播一次，同一时间只播一张 */
  if (isPhone()) {
    var queue = [];
    var busy = false;
    var drain = function () {
      if (busy || !queue.length) return;
      var card = queue.shift();
      busy = true;
      play(card);
      setTimer(function () {
        busy = false;
        drain();
      }, attrNumber(demoOf(card) || card, "data-dur", 2600) + 140);
    };
    cardObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.intersectionRatio < 0.6) return;
          cardObserver.unobserve(entry.target);
          entry.target.classList.add("is-in");
          queue.push(entry.target);
          drain();
        });
      },
      { threshold: [0.6] },
    );
    cards.forEach(function (card) {
      cardObserver.observe(card);
    });
  }

  /* 桌面 Hover / 键盘聚焦：重播一次；移出不打断，直接停在完成帧 */
  if (isFinePointer()) {
    cards.forEach(function (card) {
      var enter = function () {
        replay(card);
      };
      var focus = function () {
        replay(card);
      };
      card.addEventListener("mouseenter", enter);
      card.addEventListener("focusin", focus);
      hoverListeners.push({ card: card, enter: enter, focus: focus });
    });
  }
})();
