import { motion } from "framer-motion";
import type { CSSProperties } from "react";

import { assetUrl } from "@/lib/asset-url";
import {
  fadeInUp,
  staggerContainer,
  titleReveal,
  lineExpand,
  lineGrow,
  viewportConfig,
} from "./constants";

const columns = [
  {
    tag: {
      icon: assetUrl("/assets/landing/why-trust/icon-easy.svg"),
      label: "无忧上手",
    },
    headline: "原版 Hermes Agent，\n 一键即用",
    body: "无需自己部署、配置环境、折腾 API Key。我们帮你把原汁原味的 Hermes Agent 搬上云端，打开即是完整体验。",
  },
  {
    tag: {
      icon: assetUrl("/assets/landing/why-trust/icon-24h.svg"),
      label: "7×24H 在线",
    },
    headline: "随时唤醒， \n不消耗你的任何资源",
    body: "Hermes Agent 运行在专属云端实例上，不消耗你的本地电量和内存。无论你在手机还是电脑，随时呼唤，秒级响应，从不掉线。",
  },
  {
    tag: {
      icon: assetUrl("/assets/landing/why-trust/icon-data.svg"),
      label: "数据 100% 归属",
    },
    headline: "你的对话，\n只存于专属空间",
    body: "你与 Hermes Agent 的所有对话记录均存储在你的专属服务器中，不共享给任何第三方，随时可管理。你说了算。",
  },
];

export function WhyTrustSection() {
  return (
    <section id='why-trust' className='relative overflow-hidden'>
      {/* 深色全宽区域（移动端自适应高度、桌面保持 656px） */}
      <div
        className='lw-dark-gradient-bg relative w-full py-[64px] text-white md:py-0'
        style={{ minHeight: 656 }}
      >
        <div className='relative mx-auto h-full w-full max-w-[1440px] px-6 md:px-[120px]'>
          {/* 大标题 */}
          <motion.div
            variants={staggerContainer}
            initial='hidden'
            whileInView='visible'
            viewport={viewportConfig}
          >
            <motion.div
              variants={titleReveal}
              className='relative pt-[32px] md:pt-[100px]'
            >
              <h2 className='lw-dark-title text-[26px] leading-[1.45] md:text-inherit md:leading-inherit'>
                Hermes Agent  云端原生体验随时在线
                {/* 龙虾头像 + 紫粉渐变光晕 */}
                <span
                  className='relative mx-2 inline-block align-middle'
                  style={{ width: 40, height: 40 }}
                >
                  <img
                    src={assetUrl('/assets/landing/why-trust/title-icon.png')}
                    alt=''
                    className='relative h-full w-full object-cover'
                  />
                </span>
                ，数据由你掌控
              </h2>
            </motion.div>

            {/* 副标题 */}
            <motion.p
              variants={fadeInUp}
              className='lw-dark-body'
              style={{ marginTop: 16, marginBottom: 64 }}
            >
              我们把 Hermes Agent 搬上云端，让你无需折腾部署，随时唤醒，对话数据永远只属于你。
            </motion.p>
          </motion.div>

          {/* 网格区域：水平分隔线 + 垂直分隔线 + 十字交叉点 + 标签 + 三列内容 */}
          {/* 移动端：改为普通流式堆叠（单列），隐藏十字线网格；桌面保持绝对定位设计 */}
          <motion.div
            className='relative mt-10 md:absolute md:left-[120px] md:right-[120px] md:mt-0'
            style={{ top: undefined }}
            initial='hidden'
            whileInView='visible'
            viewport={viewportConfig}
          >
            {/* 水平分隔线 — 仅桌面显示（移动端以单列堆叠替代） */}
            <motion.div
              variants={lineExpand}
              className='hidden h-px w-full bg-white/20 md:block'
              style={{ transformOrigin: "center" }}
            />

            {/* 垂直分隔线 1 — 1/3 处（移动端隐藏） */}
            <motion.div
              variants={lineGrow}
              className='absolute hidden bg-white/20 md:block'
              style={{ left: "33.33%", top: 0, width: 1, height: 340, transformOrigin: "top" }}
            />
            {/* 垂直分隔线 2 — 2/3 处（移动端隐藏） */}
            <motion.div
              variants={lineGrow}
              className='absolute hidden bg-white/20 md:block'
              style={{ left: "66.67%", top: 0, width: 1, height: 340, transformOrigin: "top" }}
            />

            {/* 十字交叉点装饰（移动端隐藏） */}
            <img
              src={assetUrl('/assets/landing/why-trust/cross-dot-1.svg')}
              alt=''
              className='absolute hidden md:block'
              style={{
                left: "33.33%",
                top: -5,
                width: 10,
                height: 10,
                marginLeft: -5,
              }}
            />
            <img
              src={assetUrl('/assets/landing/why-trust/cross-dot-2.svg')}
              alt=''
              className='absolute hidden md:block'
              style={{
                left: "66.67%",
                top: -5,
                width: 10,
                height: 10,
                marginLeft: -5,
              }}
            />

            {/* 三列内容：移动端单列（列间大间距）、桌面三列 */}
            <motion.div
              variants={staggerContainer}
              initial='hidden'
              whileInView='visible'
              viewport={viewportConfig}
              className='grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-0'
            >
              {columns.map((col, i) => {
                // 桌面三列专用的左右内边距（为避开垂直分隔线留白）。
                // 通过 CSS 变量 + md: 前缀的 arbitrary variant，
                // 让 padding 仅在 md 断点及以上生效，移动端单列时 padding 为 0，保证三张卡片对齐一致。
                const pl = i === 0 ? "0" : "5%";
                const pr = i === 0 ? "6.67%" : i === 1 ? "4%" : "0";
                return (
                  <motion.div
                    key={i}
                    variants={fadeInUp}
                    className='flex flex-col md:[padding-left:var(--lw-col-pl)] md:[padding-right:var(--lw-col-pr)]'
                    style={{ "--lw-col-pl": pl, "--lw-col-pr": pr } as CSSProperties}
                  >
                    {/* 标签 */}
                    <div style={{ marginTop: 48 }}>
                      <span className='lw-tag-purple'>
                        <img
                          src={col.tag.icon}
                          alt=''
                          className='mr-2 h-4 w-4'
                        />
                        {col.tag.label}
                      </span>
                    </div>

                    {/* 标题 */}
                    <h3
                      className='lw-dark-card-title mt-[40px] whitespace-pre-line'
                      style={{
                        marginTop: 40,
                        marginBottom: 16,
                        lineHeight: "1.67",
                      }}
                    >
                      {col.headline}
                    </h3>

                    {/* 描述 */}
                    <p className='lw-dark-body mt-4'>{col.body}</p>
                  </motion.div>
                );
              })}
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
