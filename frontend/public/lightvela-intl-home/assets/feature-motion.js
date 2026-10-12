/* CSS owns the motion. This controller only gates playback by visibility. */
(function () {
  var root = document.getElementById('lightvela-intl-home');
  if (!root || root.dataset.featureMotionReady) return;
  root.dataset.featureMotionReady = 'true';
  var rotator = root.querySelector('#hero-rotator');
  var rotatorWrap = root.querySelector('.hero__rotator-wrap');
  var suffix = root.querySelector('.hero__suffix');
  // Keep sentence endings inside the reserved text area, before the companion.
  if (suffix && rotatorWrap) rotatorWrap.insertBefore(suffix, rotatorWrap.querySelector('.hero__rotator-line'));
  function placeStepCompanion() {
    var deploy = root.querySelector('.deploy');
    var track = root.querySelector('.track');
    var mascot = root.querySelector('.home-step-mascot');
    if (!deploy || !track || !mascot || !window.matchMedia('(min-width: 900px)').matches) return;
    var artwork = mascot.querySelector('img');
    if (!artwork) return;
    var sourceWidth = Number(artwork.getAttribute('width'));
    var footY = Number(mascot.dataset.footY);
    var renderedWidth = artwork.getBoundingClientRect().width;
    if (!(sourceWidth > 0 && footY > 0 && renderedWidth > 0)) return;
    // Layout offsets exclude the scroll entrance transform on the track.
    var lineLeft = track.offsetLeft;
    var lineTop = track.offsetTop;
    var lineWidth = track.offsetWidth;
    // Curve crest: x=80%, y=70/170 of its 132px rendered height.
    // Artwork dimensions and foot anchor come from the sole markup generator.
    mascot.style.setProperty('--step-left', (lineLeft + lineWidth * 0.8 - renderedWidth / 2) + 'px');
    mascot.style.setProperty('--step-top', (lineTop - 112 + 132 * 70 / 170 - renderedWidth * footY / sourceWidth) + 'px');
  }
  // Lazy artwork and restored-scroll layout can settle after the first pass.
  var stepArtwork = root.querySelector('.home-step-mascot img');
  if (stepArtwork) stepArtwork.addEventListener('load', placeStepCompanion);
  var stepLayoutObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(placeStepCompanion) : null;
  var stepDeploy = root.querySelector('.deploy');
  var stepTrack = root.querySelector('.track');
  if (stepLayoutObserver && stepDeploy) stepLayoutObserver.observe(stepDeploy);
  if (stepLayoutObserver && stepTrack) stepLayoutObserver.observe(stepTrack);
  // Protect a short Chinese ending from becoming a one-character last line.
  if ((root.dataset.locale || '').indexOf('zh') === 0) {
    root.querySelectorAll('.play__list li').forEach(function (item) {
      var tail = item.lastChild;
      if (!tail || tail.nodeType !== 3 || item.querySelector('.home-copy-tail')) return;
      var copy = tail.textContent;
      var match = copy.match(/[\u3400-\u9fff]{2,4}[。！？]?$/);
      if (!match) return;
      var keep = document.createElement('span');
      keep.className = 'home-copy-tail';
      keep.textContent = match[0];
      tail.textContent = copy.slice(0, -match[0].length);
      item.appendChild(keep);
    });
  }
  function sizeRotator() {
    if (!rotator || !rotatorWrap) return;
    var words = JSON.parse(root.dataset.rotatorWords || '[]');
    var ruler = rotator.cloneNode(false);
    ruler.removeAttribute('id');
    ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;';
    rotatorWrap.appendChild(ruler);
    var widest = 0;
    words.forEach(function (word) {
      ruler.textContent = word;
      widest = Math.max(widest, ruler.getBoundingClientRect().width);
    });
    ruler.remove();
    var suffixWidth = suffix ? suffix.getBoundingClientRect().width : 0;
    if (widest) rotatorWrap.style.setProperty('--hero-rotator-width', Math.ceil(widest + suffixWidth + 12) + 'px');
  }
  sizeRotator();
  placeStepCompanion();
  window.addEventListener('resize', sizeRotator);
  window.addEventListener('resize', placeStepCompanion);
  if (document.fonts) document.fonts.ready.then(function () { if (root.isConnected) placeStepCompanion(); });
  if (document.fonts) document.fonts.ready.then(function () { if (root.isConnected) sizeRotator(); });
  // Sample once per platform, so duplicate carousel rows retain the same time.
  var channelTimes = new Map();
  var usedMinutes = new Set();
  root.querySelectorAll('.feature-motion-channel').forEach(function (channel) {
    var label = channel.querySelector('span');
    var time = channel.querySelector('small');
    if (!label || !time) return;
    var name = label.firstChild.textContent.trim();
    if (!channelTimes.has(name)) {
      var minute = Math.floor(Math.random() * 1440);
      while (usedMinutes.has(minute)) minute = (minute + 1) % 1440;
      usedMinutes.add(minute);
      channelTimes.set(name, String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'));
    }
    time.textContent = channelTimes.get(name);
  });
  var cards = Array.from(root.querySelectorAll('.about__cards .wcard'));
  var visible = new Set();
  var media = window.matchMedia('(prefers-reduced-motion: reduce)');
  function sync() {
    cards.forEach(function (card) {
      card.classList.toggle('feature-motion-active', visible.has(card) && !document.hidden && !media.matches);
    });
  }
  var observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    });
    sync();
  }, { threshold: 0 });
  if (observer) cards.forEach(function (card) { observer.observe(card); });
  document.addEventListener('visibilitychange', sync);
  media.addEventListener('change', sync);
  document.addEventListener('lightvela-home-dispose', function () {
    window.removeEventListener('resize', sizeRotator);
    window.removeEventListener('resize', placeStepCompanion);
    if (stepArtwork) stepArtwork.removeEventListener('load', placeStepCompanion);
    if (stepLayoutObserver) stepLayoutObserver.disconnect();
    if (observer) observer.disconnect();
    document.removeEventListener('visibilitychange', sync);
    media.removeEventListener('change', sync);
    cards.forEach(function (card) { card.classList.remove('feature-motion-active'); });
    delete root.dataset.featureMotionReady;
  }, { once: true });
})();
