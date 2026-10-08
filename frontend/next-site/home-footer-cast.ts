const VIDEO = '/lightvela-intl-home/assets/footer-cast-video.mp4';
const PINGPONG = '/lightvela-intl-home/assets/footer-cast-pingpong.mp4';
const FIRST_FRAME = '/lightvela-intl-home/assets/footer-cast-first.webp';
const FINAL_FRAME = '/lightvela-intl-home/assets/footer-cast-final.webp';

export function mountFooterCast(root: HTMLElement): () => void {
  const footer = root.querySelector<HTMLElement>('.foot');
  if (!footer || footer.querySelector('.home-footer-cast')) return () => {};

  const cast = document.createElement('div');
  cast.className = 'home-footer-cast';
  cast.setAttribute('aria-hidden', 'true');
  const scene = document.createElement('div');
  scene.className = 'home-footer-cast__scene';
  const video = document.createElement('video');
  video.className = 'home-footer-cast__video';
  video.src = VIDEO;
  video.poster = FIRST_FRAME;
  video.preload = 'metadata';
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  const loop = document.createElement('video');
  loop.className = 'home-footer-cast__loop';
  loop.src = PINGPONG;
  loop.preload = 'auto';
  loop.muted = true;
  loop.defaultMuted = true;
  loop.playsInline = true;
  loop.loop = true;
  loop.setAttribute('muted', '');
  loop.setAttribute('playsinline', '');
  loop.setAttribute('aria-hidden', 'true');
  const still = document.createElement('img');
  still.className = 'home-footer-cast__still';
  still.src = FINAL_FRAME;
  still.alt = '';
  still.width = 1920;
  still.height = 900;
  still.loading = 'lazy';
  scene.append(video, loop, still);
  cast.append(scene);
  footer.classList.add('has-footer-portrait');
  footer.append(cast);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let disposed = false;
  let visible = false;
  let started = false;
  let looping = false;
  function play() {
    if (disposed || !visible || document.hidden || reduced.matches) return;
    if (!started) {
      started = true;
      video.currentTime = 0;
    }
    void (looping ? loop : video).play().catch(() => {});
  }
  function stopAndReset() {
    video.pause();
    loop.pause();
    started = false;
    looping = false;
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) video.currentTime = 0;
    if (loop.readyState >= HTMLMediaElement.HAVE_METADATA) loop.currentTime = 0;
    scene.classList.remove('is-looping');
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const nowVisible = entry.isIntersecting && entry.intersectionRatio >= .2;
      if (nowVisible === visible) continue;
      visible = nowVisible;
      if (visible) play();
      else stopAndReset();
    }
  }, { threshold: [0, .2] });
  observer.observe(cast);

  function onEnded() {
    if (!visible || document.hidden || reduced.matches || disposed) return;
    // The reverse-forward loop begins and ends on the intro's final frame.
    looping = true;
    loop.currentTime = 0;
    void loop.play().catch(() => {});
  }
  function onLoopPlaying() {
    if (visible && !document.hidden && !disposed) scene.classList.add('is-looping');
  }
  function onPreference() {
    if (reduced.matches) stopAndReset();
    else play();
  }
  function onVisibility() {
    if (document.hidden) { video.pause(); loop.pause(); }
    else play();
  }
  video.addEventListener('ended', onEnded);
  loop.addEventListener('playing', onLoopPlaying);
  reduced.addEventListener('change', onPreference);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    video.removeEventListener('ended', onEnded);
    loop.removeEventListener('playing', onLoopPlaying);
    reduced.removeEventListener('change', onPreference);
    document.removeEventListener('visibilitychange', onVisibility);
    stopAndReset();
    cast.remove();
    footer.classList.remove('has-footer-portrait');
  };
}
