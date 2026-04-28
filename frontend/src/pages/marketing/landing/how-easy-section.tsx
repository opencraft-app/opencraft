import { motion } from "framer-motion";

import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { fadeInUp, staggerContainer, titleReveal, viewportConfig, stepLineGrow } from "./constants";

export function HowEasySection() {
  const t = useT();
  const steps = [
    {
      number: "1",
      title: t("点击「立即创建」"),
      desc: t("选择订阅，点一下按钮，就这样"),
      badgeText: t("约 5 秒"),
    },
    {
      number: "2",
      title: t("全自动云端创建"),
      desc: t("喝口水的功夫，云端 Hermes Agent 即创建完成。"),
      badgeText: t("约 5 秒"),
    },
    {
      number: "3",
      title: t("和智能伙伴开始对话"),
      desc: t("创建完成后，绑定聊天通道，即刻开始探索之旅"),
      badgeText: t("开始探索！"),
    },
  ];

  return (
    <section id="how-easy" className="bg-white">
      <div className="mx-auto w-full max-w-[1200px] px-6 pb-[64px] pt-[56px] md:px-10 md:pb-[120px] md:pt-[88px]">
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[484px_1fr] lg:gap-16">
          {/* 左侧：Badge + 标题 */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            whileInView="visible"
            viewport={viewportConfig}
          >
            <motion.div variants={fadeInUp} className="mb-4">
              <span
                className="inline-flex items-center gap-2 rounded-[38px] px-5 py-1.5 text-[20px] font-medium leading-[1.2] text-white"
                style={{
                  background: "linear-gradient(117deg, rgba(2,2,2,1) 0%, rgba(19,16,30,1) 72%, rgba(81,148,255,1) 92%, rgba(121,255,233,1) 100%)",
                }}
              >
                <img
                  src={assetUrl("/assets/landing/how-easy/how-easy-badge-icon.svg")}
                  alt=""
                  className="h-7 w-7"
                />
                {t("难不难")}
              </span>
            </motion.div>
            <motion.h2
              variants={titleReveal}
              className="font-heading text-[28px] font-semibold leading-[1.5] text-black md:text-[36px] md:leading-[1.78]"
            >
              {/*
               * 「10秒钟搞定」作为整体翻译 key，避免拆成 t("10秒钟")+t("搞定")
               * 在英文环境下被拼成 "10 secondssetup" 的语法错误；
               * 加粗部分用 <bold> 占位符 + 运行时 split 渲染为 <span className="font-bold">。
               */}
              {(() => {
                const raw = t("<bold>10秒钟</bold>搞定");
                const match = raw.match(/^(.*?)<bold>(.*?)<\/bold>(.*)$/);
                if (!match) {
                  /* 兜底：字典里没按占位符约定翻译时原样渲染 */
                  return raw;
                }
                const [, prefix, boldText, suffix] = match;
                return (
                  <>
                    {prefix}
                    <span className="font-bold">{boldText}</span>
                    {suffix}
                  </>
                );
              })()}
              <br />
              {t("真的不难")}
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
                  {/* 时间标签（HTML 渲染，文案可维护） */}
                  <div
                    className="mb-6 inline-flex items-center justify-center rounded-full px-4"
                    style={{
                      height: 32,
                      minWidth: 144,
                      backgroundColor: "rgba(133, 133, 133, 0.1)",
                      fontFamily: "Kalam, cursive",
                      fontWeight: 700,
                      fontSize: 16,
                      lineHeight: "24px",
                      color: "#231503",
                      WebkitTextStroke: "0.5px #231503",
                    }}
                  >
                    {step.badgeText}
                  </div>
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
