import { useEffect, useRef, useState } from 'react';
import type { VideoContent } from '../types';

export default function VideoPlayer({ video }: { video: VideoContent }) {
  const player = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const media = player.current;
    return () => { media?.pause(); };
  }, [video.src]);

  return <section className="video-player">
    <span className="supplement-kicker">产品现状 · 官网新视觉</span>
    <h2>{video.title}</h2>
    <video ref={player} src={video.src} poster={video.poster} controls playsInline preload="metadata"
      aria-label={video.title} onError={() => setFailed(true)}>
      当前浏览器不支持视频播放。
    </video>
    {failed && <p role="status">视频暂时无法加载，请检查网络后重新打开。<a href={video.src} target="_blank" rel="noopener noreferrer">在独立窗口查看原视频</a></p>}
    <p>中文首页新视觉演示 · {video.duration.toFixed(1)} 秒 · 手动播放 · 按 Esc 关闭</p>
    <p className="video-scope">演示包含首页与视觉动效，不代表产品内交互视觉已全面更新。</p>
  </section>;
}
