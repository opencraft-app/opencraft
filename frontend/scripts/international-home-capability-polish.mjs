const copy = {
 "en-US": ["24/7 online", "Preference: conclusions first"],
 "zh-CN": ["24/7 持续在线", "偏好：先给结论，再列依据"],
 "zh-SG": ["24/7 持续在线", "偏好：先给结论，再列依据"],
 "zh-Hant": ["24/7 持續在線", "偏好：先給結論，再列依據"],
 "es": ["En línea 24/7", "Preferencia: conclusiones primero"],
 "id-ID": ["Online 24/7", "Preferensi: kesimpulan dahulu"],
 "ja-JP": ["24時間稼働", "設定：結論から先に"],
 "ko-KR": ["24시간 온라인", "선호: 결론부터 먼저"]
};
const DEFAULT_LOCALE = "en-US";
const CARD_INDEX = {
 CLOUD: 1,
 AUTO: 2,
 MEMORY: 5,
};
const COPY_INDEX = {
 CLOUD_STATUS: 0,
 MEMORY_PREFERENCE: 1,
};

export function polishCapabilityCards(document, locale) {
 const c = copy[locale] || copy[DEFAULT_LOCALE];
 const cards = document.querySelectorAll(".about__cards .wcard");
 if (cards.length !== 6) return;
 const cloud = cards[CARD_INDEX.CLOUD]?.querySelector(".wcard__demo--cloud");
 if (cloud && !cloud.querySelector(".cloud-status")) cloud.insertAdjacentHTML("beforeend", '<span class="cloud-status"><i></i>' + c[COPY_INDEX.CLOUD_STATUS] + '</span>');
 const memory = cards[CARD_INDEX.MEMORY]?.querySelector(".wcard__demo--mem");
 if (memory && !memory.querySelector(".memory-preference")) memory.insertAdjacentHTML("beforeend", '<span class="memory-preference">' + c[COPY_INDEX.MEMORY_PREFERENCE] + '</span>');
 const aut = cards[CARD_INDEX.AUTO];
 aut?.querySelector(".aut__bar")?.remove();
 const rules = aut?.querySelector(".aut__rules");
 if (rules) { while (rules.children.length > 4) rules.lastElementChild.remove(); }
}
