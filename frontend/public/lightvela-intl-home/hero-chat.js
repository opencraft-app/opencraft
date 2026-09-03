(function () {
  var root = document.getElementById('lightvela-intl-home');
  var locale = root && root.dataset.locale ? root.dataset.locale : document.documentElement.lang;
  var copies = {"en-US":{"replyText":"Your AI companion is waiting to start. Create it in Workbench. If your plan is not active yet, go to Pricing first.","linkText":"Create in workbench","pricingText":"View pricing","pricingHref":"/subscribe","you":"You","justNow":"just now"},"zh-CN":{"replyText":"你的 AI 伙伴等待启动中，请去工作台创建；如果还没有购买，先去购买页。","linkText":"去工作台创建","pricingText":"去购买页","pricingHref":"/subscribe","you":"我","justNow":"刚刚"},"zh-SG":{"replyText":"你的 AI 伙伴等待启动中，请去工作台创建；如果还没有购买，先去购买页。","linkText":"去工作台创建","pricingText":"去购买页","pricingHref":"/zh-sg/subscribe","you":"我","justNow":"刚刚"},"zh-Hant":{"replyText":"你的 AI 夥伴等待啟動中，請去工作臺創建；如果還沒有購買，先去購買頁。","linkText":"去工作臺創建","pricingText":"去購買頁","pricingHref":"/zh-hant/subscribe","you":"我","justNow":"剛剛"},"id-ID":{"replyText":"Pendamping AI kamu siap dimulai. Buat di ruang kerja. Jika paket belum aktif, buka halaman harga lebih dulu.","linkText":"Buka ruang kerja","pricingText":"Lihat harga","pricingHref":"/id-id/subscribe","you":"Anda","justNow":"baru saja"},"es":{"replyText":"Tu compañero de IA está listo para empezar. Créalo en el área de trabajo. Si tu plan aún no está activo, ve primero a precios.","linkText":"Abrir área de trabajo","pricingText":"Ver precios","pricingHref":"/es/subscribe","you":"Tú","justNow":"ahora"},"ja-JP":{"replyText":"あなたのAIパートナーは起動待ちです。ワークベンチで作成してください。プランがまだ有効でない場合は、先に料金ページへ進んでください。","linkText":"ワークベンチで作成","pricingText":"料金を見る","pricingHref":"/ja-jp/subscribe","you":"あなた","justNow":"たった今"},"ko-KR":{"replyText":"당신의 AI 파트너가 시작을 기다리고 있습니다. 워크벤치에서 먼저 만들어 주세요. 플랜이 아직 활성화되지 않았다면 요금 페이지로 먼저 이동하세요.","linkText":"워크벤치에서 만들기","pricingText":"요금 보기","pricingHref":"/ko-kr/subscribe","you":"나","justNow":"방금"}};
  var copy = copies[locale] || copies['en-US'];
  var replyText = copy.replyText;
  var linkText = copy.linkText;
  var pricingText = copy.pricingText;
  var pricingHref = copy.pricingHref || '/subscribe';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var replayRun = 0;
  var replayTimers = [];
  var activeReplayPanel = null;
  var replayPending = false;
  var TYPE_SPEED = 10;
  var MSG_GAP = 260;
  var currentScroller = null;
  var currentMessage = null;

  // 滚动跟随「当前正在播放的消息」，聊天内容区可正常滚动
  function stickToBottom() {
    if (!currentScroller || !currentMessage) return;
    var target =
      currentMessage.offsetTop +
      currentMessage.offsetHeight -
      currentScroller.clientHeight +
      16;
    var max = currentScroller.scrollHeight - currentScroller.clientHeight;
    currentScroller.scrollTop = Math.max(0, Math.min(target, max));
  }

  function schedule(callback, delay) {
    var timer = window.setTimeout(callback, delay);
    replayTimers.push(timer);
    return timer;
  }

  function clearReplayTimers() {
    replayTimers.forEach(function (timer) { window.clearTimeout(timer); });
    replayTimers = [];
  }

  function getCopies(message) {
    if (message.classList.contains('bub')) {
      return Array.prototype.slice.call(
        message.querySelectorAll('.bub__box > p:not(.bub__time), .bub__box > pre.bub__report > code')
      );
    }
    return Array.prototype.slice.call(message.querySelectorAll(':scope > div > p'));
  }

  function originalHtml(copy) {
    if (!copy.dataset.heroReplayHtml) {
      copy.dataset.heroReplayHtml = copy.dataset.fullHtml || copy.innerHTML;
    }
    return copy.dataset.heroReplayHtml;
  }

  function tokensFor(html) {
    var tokens = [];
    var index = 0;
    while (index < html.length) {
      if (html[index] === '<') {
        var end = html.indexOf('>', index);
        if (end === -1) {
          tokens.push(html.slice(index));
          break;
        }
        tokens.push(html.slice(index, end + 1));
        index = end + 1;
      } else {
        tokens.push(html[index]);
        index += 1;
      }
    }
    return tokens;
  }

  function typeCopy(copy, run, done) {
    var tokens = tokensFor(originalHtml(copy));
    var index = 0;

    function write() {
      if (run !== replayRun) return;
      if (index <= tokens.length) {
        copy.innerHTML = tokens.slice(0, index).join('');
        stickToBottom();
        index += 1;
        schedule(write, TYPE_SPEED);
        return;
      }
      done();
    }
    write();
  }

  function revealPanel(panel) {
    if (!panel || !replayPending || panel !== activeReplayPanel) return;
    replayRun += 1;
    clearReplayTimers();
    panel.querySelectorAll('.bub, .dc__msg').forEach(function (message) {
      message.classList.remove('is-typing');
      message.classList.add('is-in', 'is-done');
      getCopies(message).forEach(function (copy) {
        copy.innerHTML = originalHtml(copy);
      });
    });
    activeReplayPanel = null;
    replayPending = false;
  }

  function replayPanel(panel) {
    replayRun += 1;
    var run = replayRun;
    clearReplayTimers();
    var allMessages = document.querySelectorAll('.hero__frame .panel .bub, .hero__frame .panel .dc__msg');
    allMessages.forEach(function (message) {
      message.classList.remove('is-in', 'is-typing', 'is-done');
      getCopies(message).forEach(function (copy) {
        originalHtml(copy);
        copy.innerHTML = '';
      });
    });
    activeReplayPanel = panel;
    replayPending = !!panel;
    if (!panel) return;

    if (reduceMotion) {
      allMessages.forEach(function (message) {
        message.classList.add('is-in', 'is-done');
        getCopies(message).forEach(function (copy) {
          copy.innerHTML = originalHtml(copy);
        });
      });
      activeReplayPanel = null;
      replayPending = false;
      return;
    }

    var scroller = panel.querySelector('.native__body, .dc__body');
    currentScroller = scroller;
    currentMessage = null;
    if (scroller) scroller.scrollTop = 0;
    var messages = Array.prototype.slice.call(
      panel.querySelectorAll('.bub, .dc__msg')
    );
    var messageIndex = 0;

    function nextMessage() {
      if (run !== replayRun) return;
      if (messageIndex >= messages.length) {
        activeReplayPanel = null;
        replayPending = false;
        return;
      }
      var message = messages[messageIndex];
      currentMessage = message;
      var copies = getCopies(message);
      var isAgent =
        message.classList.contains('bub--ai') ||
        message.classList.contains('dc__bot') ||
        !!message.querySelector('.tg__bot-name');

      // 非 Hermes Agent 的内容：直接淡入，不逐字流式
      if (!isAgent) {
        message.classList.add('is-in', 'is-done');
        copies.forEach(function (copy) {
          copy.innerHTML = originalHtml(copy);
        });
        stickToBottom();
        messageIndex += 1;
        schedule(nextMessage, MSG_GAP);
        return;
      }

      // Hermes Agent 的内容：逐字流式输出
      message.classList.add('is-in', 'is-typing');
      stickToBottom();
      var copyIndex = 0;

      function nextCopy() {
        if (run !== replayRun) return;
        if (copyIndex >= copies.length) {
          message.classList.remove('is-typing');
          message.classList.add('is-done');
          messageIndex += 1;
          schedule(nextMessage, MSG_GAP);
          return;
        }
        typeCopy(copies[copyIndex], run, function () {
          copyIndex += 1;
          nextCopy();
        });
      }
      nextCopy();
    }

    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(nextMessage);
    });
  }

  function scrollToBottom(panel) {
    var scroller = panel.querySelector('.native__body, .dc__body');
    if (!scroller) return;
    requestAnimationFrame(function () {
      scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function nativeMessage(kind, text) {
    var row = document.createElement('div');
    row.className = 'bub ' + (kind === 'me' ? 'bub--me ' : 'bub--ai ') + 'hero-live-msg is-in is-done';
    var box = document.createElement('div');
    box.className = 'bub__box';
    var name = document.createElement('span');
    name.className = 'bub__name' + (kind === 'ai' ? ' hero-live-reply-name' : '');
    name.textContent = kind === 'ai' ? 'LightVela' : (copy.you);
    var copy = document.createElement('p');
    copy.textContent = text;
    box.appendChild(name);
    box.appendChild(copy);
    if (kind === 'ai') {
      var link = document.createElement('a');
      link.className = 'hero-live-link';
      link.href = '/agents';
      link.textContent = linkText;
      box.appendChild(link);
      var pricingLink = document.createElement('a');
      pricingLink.className = 'hero-live-link hero-live-link--secondary';
      pricingLink.href = pricingHref;
      pricingLink.textContent = pricingText;
      box.appendChild(pricingLink);
    }
    row.appendChild(box);
    return row;
  }

  function channelMessage(kind, text) {
    var row = document.createElement('div');
    row.className = 'dc__msg ' + (kind === 'ai' ? 'dc__bot ' : 'dc__msg--me ') + 'hero-live-msg';
    var body = document.createElement('div');
    var name = document.createElement('b');
    name.className = kind === 'ai' ? 'hero-live-reply-name' : '';
    name.textContent = kind === 'ai' ? 'LightVela' : (copy.you);
    var time = document.createElement('span');
    time.textContent = copy.justNow;
    name.appendChild(time);
    var copy = document.createElement('p');
    copy.textContent = text;
    body.appendChild(name);
    body.appendChild(copy);
    if (kind === 'ai') {
      var link = document.createElement('a');
      link.className = 'hero-live-link';
      link.href = '/agents';
      link.textContent = linkText;
      body.appendChild(link);
      var pricingLink = document.createElement('a');
      pricingLink.className = 'hero-live-link hero-live-link--secondary';
      pricingLink.href = pricingHref;
      pricingLink.textContent = pricingText;
      body.appendChild(pricingLink);
    }
    row.appendChild(body);
    return row;
  }

  document.querySelectorAll('.hero__frame .panel').forEach(function (panel) {
    var conversation = panel.querySelector('.native__body, .dc__body');
    if (conversation) {
      conversation.addEventListener('click', function () {
        revealPanel(panel);
      });
    }

    var input = panel.querySelector('.native__foot input, .native__composer input, .dc__composer input');
    var thread = panel.querySelector('.native__thread, .dc__body');
    if (!input || !thread) return;
    var sending = false;

    function send() {
      var text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      input.value = '';
      var isNative = !!panel.querySelector('.native');
      thread.appendChild(isNative ? nativeMessage('me', text) : channelMessage('me', text));
      scrollToBottom(panel);
      window.setTimeout(function () {
        thread.appendChild(isNative ? nativeMessage('ai', replyText) : channelMessage('ai', replyText));
        scrollToBottom(panel);
        sending = false;
      }, 420);
    }

    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      send();
    });

    var form = input.closest('form');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        send();
      });
    }

    var sendButton = panel.querySelector('.native__send');
    if (sendButton) sendButton.addEventListener('click', send);
  });

  document.querySelectorAll('.hero__stage > input[name="surface"]').forEach(function (tab) {
    tab.addEventListener('change', function () {
      if (!tab.checked) return;
      replayPanel(document.querySelector('#panel-' + tab.id.replace('tab-', '')));
    });
  });
  if (document.querySelector('.hero__stage > input[name="surface"]:checked')) {
    var currentTab = document.querySelector('.hero__stage > input[name="surface"]:checked');
    replayPanel(document.querySelector('#panel-' + currentTab.id.replace('tab-', '')));
  }

  var stage = document.querySelector('.hero__stage');
  var mascot = stage && stage.querySelector('.hero__mascot');
  var finePointer = window.matchMedia('(pointer: fine)').matches;
  if (stage && mascot && finePointer && !reduceMotion) {
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }
    stage.addEventListener('pointermove', function (event) {
      var rect = stage.getBoundingClientRect();
      var x = ((event.clientX - rect.left) / rect.width - 0.5) * 80;
      var y = ((event.clientY - rect.top) / rect.height - 0.5) * 44;
      mascot.style.setProperty('--mascot-x', clamp(x, -40, 40).toFixed(1) + 'px');
      mascot.style.setProperty('--mascot-y', clamp(y, -22, 22).toFixed(1) + 'px');
    });
    stage.addEventListener('pointerleave', function () {
      mascot.style.setProperty('--mascot-x', '0px');
      mascot.style.setProperty('--mascot-y', '0px');
    });
  }
})();
