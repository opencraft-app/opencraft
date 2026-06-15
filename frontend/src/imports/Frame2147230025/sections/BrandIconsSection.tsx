import React from 'react';
import imgFrame2147230060 from '../frame2147230060.png';
import '../motion.css';
import { useScrollReveal } from '../useScrollReveal';

/* 每个品牌 icon 的底层内容（72×72 卡片 + icon 图片），提取为独立渲染单元 */
export default function BrandIconsSection() {
  const ref = useScrollReveal();
  return (
    <section className="w-full py-10" ref={ref as React.RefObject<HTMLElement>}>
      <div className="mx-auto px-16" style={{ width: 'min(1440px, calc(100vw - 128px))' }}>
        <div className="flex justify-center lv-reveal">
          <img alt="" className="max-w-full h-auto" src={imgFrame2147230060} />
        </div>
      </div>
    </section>
  );
}
