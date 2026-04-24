import { motion } from "framer-motion";

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
      icon: "/assets/landing/why-trust/icon-easy.svg",
      label: "无忧上手",
    },
    headline: "原版 OpenClaw，\n 一键即用",
    body: "无需自己部署、配置环境、折腾 API Key。我们帮你把原汁原味的 OpenClaw 搬上云端，打开即是完整体验。",
  },
  {
    tag: {
      icon: "/assets/landing/why-trust/icon-24h.svg",
      label: "7×24H 在线",
    },
    headline: "随时唤醒， \n不消耗你的任何资源",
    body: "OpenClaw 运行在专属云端实例上，不消耗你的本地电量和内存。无论你在手机、电脑还是微信里，随时呼唤，秒级响应，从不掉线。",
  },
  {
    tag: {
      icon: "/assets/landing/why-trust/icon-data.svg",
      label: "数据 100% 归属",
    },
    headline: "你的对话，\n只存于专属空间",
    body: "你与 OpenClaw 的所有对话记录均存储在你的专属服务器中，不经过我们，不共享给任何第三方，随时可管理。你说了算。",
  },
];

export function WhyTrustSection() {
  return (
    <section id='why-trust' className='relative overflow-hidden'>
      {/* 深色全宽区域 */}
      <div
        className='lw-dark-gradient-bg relative w-full text-white'
        style={{ height: 656 }}
      >
        <div className='relative mx-auto h-full max-w-[1440px] px-[120px]'>
          {/* 紫色光晕装饰 */}
          <div
            className='pointer-events-none absolute'
            style={{
              right: 37,
              top: 144,
              width: 274,
              height: 113,
              opacity: 0.2,
              filter: "blur(59.5px)",
              background:
                "linear-gradient(180deg, rgba(158, 96, 255, 1) 0%, rgba(146, 77, 255, 1) 100%)",
            }}
          />

          {/* 右上角龙虾图片 */}
          <div
            className='absolute'
            style={{ right: 127, top: 142, width: 123, height: 114 }}
          >
            <img
              src='/assets/landing/why-trust/mascot-small.png'
              alt=''
              className='h-full w-full object-cover'
            />
          </div>

          {/* 大标题 */}
          <motion.div
            variants={staggerContainer}
            initial='hidden'
            whileInView='visible'
            viewport={viewportConfig}
          >
            <motion.div
              variants={titleReveal}
              className='relative'
              style={{ paddingTop: 100 }}
            >
              <h2 className='lw-dark-title'>
                OpenClaw 云端原生体验随时在线
                {/* 龙虾头像 + 紫粉渐变光晕 */}
                <span
                  className='relative mx-2 inline-block align-middle'
                  style={{ width: 40, height: 40 }}
                >
                  <img
                    src='/assets/landing/why-trust/title-icon.png'
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
              style={{ marginTop: 16 }}
            >
              我们把 OpenClaw
              搬上云端，让你无需折腾部署，随时唤醒，对话数据永远只属于你。
            </motion.p>
          </motion.div>

          {/* 网格区域：水平分隔线 + 垂直分隔线 + 十字交叉点 + 标签 + 三列内容 */}
          <motion.div
            className='absolute left-[120px] right-[120px]'
            style={{ top: 256 }}
            initial='hidden'
            whileInView='visible'
            viewport={viewportConfig}
          >
            {/* 水平分隔线 — 从中心向两侧展开 */}
            <motion.div
              variants={lineExpand}
              className='h-px w-full bg-white/20'
              style={{ transformOrigin: "center" }}
            />

            {/* 垂直分隔线 1 — 1/3 处，从上向下生长 */}
            <motion.div
              variants={lineGrow}
              className='absolute bg-white/20'
              style={{ left: "33.33%", top: 0, width: 1, height: 340, transformOrigin: "top" }}
            />
            {/* 垂直分隔线 2 — 2/3 处，从上向下生长 */}
            <motion.div
              variants={lineGrow}
              className='absolute bg-white/20'
              style={{ left: "66.67%", top: 0, width: 1, height: 340, transformOrigin: "top" }}
            />

            {/* 十字交叉点装饰 */}
            <img
              src='/assets/landing/why-trust/cross-dot-1.svg'
              alt=''
              className='absolute'
              style={{
                left: "33.33%",
                top: -5,
                width: 10,
                height: 10,
                marginLeft: -5,
              }}
            />
            <img
              src='/assets/landing/why-trust/cross-dot-2.svg'
              alt=''
              className='absolute'
              style={{
                left: "66.67%",
                top: -5,
                width: 10,
                height: 10,
                marginLeft: -5,
              }}
            />

            {/* 三列内容 */}
            <motion.div
              variants={staggerContainer}
              initial='hidden'
              whileInView='visible'
              viewport={viewportConfig}
              className='grid grid-cols-3'
              style={{ gap: 0 }}
            >
              {columns.map((col, i) => {
                const pl = i === 0 ? 0 : "5%";
                const pr = i === 0 ? "6.67%" : i === 1 ? "4%" : 0;
                return (
                  <motion.div
                    key={i}
                    variants={fadeInUp}
                    className='flex flex-col'
                    style={{ paddingLeft: pl, paddingRight: pr }}
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
