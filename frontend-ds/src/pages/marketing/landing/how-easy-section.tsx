import { motion } from "framer-motion";

import { fadeInUp, staggerContainer, titleReveal, viewportConfig, stepLineGrow } from "./constants";

const steps = [
  {
    number: "1",
    title: "点击「立即创建」",
    desc: "点一下按钮，填个名字，就这样",
    timeBadge: "/assets/landing/how-easy/time-badge-step1.svg",
  },
  {
    number: "2",
    title: "系统自动帮你创建",
    desc: "你喝口水的功夫，云端LightClaw即创建完成。",
    timeBadge: "/assets/landing/how-easy/time-badge-step2.svg",
  },
  {
    number: "3",
    title: "和 OpenClaw 开始对话",
    desc: "创建完成后，绑定聊天通道，即刻开始\u201C养龙虾\u201D",
    timeBadge: "/assets/landing/how-easy/time-badge-step3.svg",
  },
];

export function HowEasySection() {
  return (
    <section id="how-easy" className="bg-white">
      <div className="mx-auto max-w-[1440px] px-[120px] py-[120px]">
        <div className="grid grid-cols-1 items-start gap-16 lg:grid-cols-[484px_1fr]">
          {/* 左侧：Badge + 标题 */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            whileInView="visible"
            viewport={viewportConfig}
          >
            <motion.div variants={fadeInUp} className="mb-4">
              <span className="lw-badge">
                <img
                  src="/assets/landing/how-easy/how-easy-badge-icon.svg"
                  alt=""
                  className="h-7 w-7"
                />
                难不难
              </span>
            </motion.div>
            <motion.h2
              variants={titleReveal}
              className="font-heading text-[40px] font-semibold leading-[1.6] text-black"
            >
              1 分钟
              <br />
              搞定真的不难
            </motion.h2>
          </motion.div>

          {/* 右侧：步骤列表 */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            whileInView="visible"
            viewport={viewportConfig}
            className="relative"
          >
            {steps.map((step, i) => (
              <motion.div
                key={i}
                custom={i}
                variants={{
                  hidden: { opacity: 0, x: 24 },
                  visible: (idx: number) => ({
                    opacity: 1,
                    x: 0,
                    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1], delay: idx * 0.18 },
                  }),
                }}
                className="group relative flex gap-6 last:mb-0"
                style={{ marginBottom: i < steps.length - 1 ? 24 : 0 }}
              >
                {/* 左侧：编号圆圈 + 连接线 */}
                <div className="flex shrink-0 flex-col items-center">
                  <div className="lw-step-number">{step.number}</div>
                  {i < steps.length - 1 && (
                    <motion.div
                      custom={i}
                      variants={stepLineGrow}
                      className="lw-step-line"
                      style={{ transformOrigin: "top" }}
                    />
                  )}
                </div>

                {/* 右侧：时间标签 + 标题 + 描述 */}
                <div className="flex-1" style={{ maxWidth: 500 }}>
                  {/* 时间标签（完整 SVG） */}
                  <img
                    src={step.timeBadge}
                    alt=""
                    style={{ width: 144, height: 32 }}
                    className="mb-6"
                  />
                  {/* 标题 */}
                  <h3
                    className="mb-4 font-heading text-[24px] font-semibold leading-[1.33]"
                    style={{ color: "rgba(0, 0, 0, 0.9)" }}
                  >
                    {step.title}
                  </h3>
                  {/* 描述 */}
                  <p
                    className="text-[16px] font-normal leading-[1.5]"
                    style={{ color: "rgba(0, 0, 0, 0.7)" }}
                  >
                    {step.desc}
                  </p>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
