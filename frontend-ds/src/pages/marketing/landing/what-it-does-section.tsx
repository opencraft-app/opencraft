import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";

import { fadeInUp, staggerContainer, titleReveal, viewportConfig } from "./constants";

/* ── 场景数据 ── */
const scenesMeta = [
  {
    title: "帮你搜资料",
    desc: "告诉它你想了解什么，它去搜、去读、去整理",
  },
  {
    title: "帮你读文档",
    desc: "扔给它一份 PDF 或网页链接，它帮你提炼重点",
  },
  {
    title: "帮你写内容",
    desc: "写邮件、写方案、润色文案——说清楚你想要什么",
  },
  {
    title: "帮你想点子",
    desc: "卡住了？跟它聊聊，一起头脑风暴",
  },
];

/* ── 加号/减号图标 ── */
function PlusIcon({ className }: { className?: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M7 11.5078H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 6.50781L12 16.5078" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon({ className }: { className?: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M7 11.5078H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function WhatItDoesSection() {
  const [activeIndex, setActiveIndex] = useState(0);

  const handleToggle = (index: number) => {
    setActiveIndex(index === activeIndex ? -1 : index);
  };

  return (
    <section
      id="what-it-does"
      className="relative z-[1] overflow-hidden bg-white"
      style={{ borderRadius: "61px 61px 0 0" }}
    >
      <div className="mx-auto max-w-[1440px] px-[120px] pb-[88px]">
        {/* 头部：Badge + 标题（单独一行） */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="pt-[88px]"
        >
          {/* Badge */}
          <motion.div variants={fadeInUp} className="mb-4">
            <span className="lw-badge">
              <img
                src="/assets/landing/what-it-does/what-it-does-icon.svg"
                alt=""
                className="h-7 w-7"
              />
              能做什么
            </span>
          </motion.div>

          {/* 标题 */}
          <motion.h2
            variants={titleReveal}
            className="font-heading text-[40px] font-semibold leading-[1.6] tracking-tight text-black"
            style={{ maxWidth: 360 }}
          >
            你只管说，它帮你办
          </motion.h2>
        </motion.div>

        {/* 左右分栏容器 */}
        <div className="relative mt-10 flex" style={{ height: 560 }}>
          {/* 左侧：手风琴列表 */}
          <div className="flex flex-shrink-0 items-end" style={{ width: 421, height: 560 }}>
            {/* 手风琴功能列表 */}
            <motion.div
              variants={staggerContainer}
              initial="hidden"
              whileInView="visible"
              viewport={viewportConfig}
              className="flex flex-col justify-between"
              style={{ width: 421, minHeight: 480 }}
            >
              {scenesMeta.map((scene, i) => (
                <motion.div key={scene.title} variants={fadeInUp}>
                  {/* 功能项 */}
                  <button
                    onClick={() => handleToggle(i)}
                    aria-expanded={activeIndex === i}
                    className="flex w-full cursor-pointer items-center justify-between py-0 text-left"
                  >
                    <div className="flex flex-col gap-2" style={{ maxWidth: 320 }}>
                      {/* 标题行 */}
                      <span className="font-heading text-[24px] font-medium leading-[2] text-black">
                        {scene.title}
                      </span>
                      {/* 描述（展开时显示） */}
                      <AnimatePresence initial={false}>
                        {activeIndex === i && (
                          <motion.p
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                            className="overflow-hidden text-[16px] font-normal leading-[1.75] text-black/70"
                          >
                            {scene.desc}
                          </motion.p>
                        )}
                      </AnimatePresence>
                    </div>
                    {/* 加号/减号图标 */}
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-black">
                      {activeIndex === i ? <MinusIcon /> : <PlusIcon />}
                    </div>
                  </button>
                  {/* 分隔线（最后一项不显示） */}
                  {i < scenesMeta.length - 1 && (
                    <div
                      className="mt-6"
                      style={{ width: 418, height: 1, backgroundColor: "#E9ECF1" }}
                    />
                  )}
                </motion.div>
              ))}
            </motion.div>
          </div>

          {/* 右侧：装饰卡片 */}
          <div className="absolute -right-[120px] bottom-0" style={{ width: 805, height: 560 }}>
            <div
              className="relative h-full w-full overflow-hidden"
              style={{
                backgroundColor: "#FFEED8",
                borderRadius: 32,
              }}
            >
              {/* 聊天窗口预览图 */}
              <img
                src="/assets/landing/what-it-does/chat-window.png"
                alt="LightClaw 聊天预览"
                className="absolute"
                style={{
                  left: 80,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 647,
                  height: 460,
                  objectFit: "contain",
                  borderRadius: 12,
                  boxShadow: "0 8px 30px rgba(0,0,0,0.08)",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
