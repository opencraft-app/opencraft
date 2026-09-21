const copy = {
 "en-US": "24/7 online",
 "zh-CN": "24/7 持续在线",
 "zh-SG": "24/7 持续在线",
 "zh-Hant": "24/7 持續在線",
 "es": "En línea 24/7",
 "id-ID": "Online 24/7",
 "ja-JP": "24時間稼働",
 "ko-KR": "24시간 온라인"
};
const DEFAULT_LOCALE = "en-US";
const CARD_INDEX = {
 CLOUD: 1,
 AUTO: 2,
};

export function polishCapabilityCards(document, locale) {
 const c = copy[locale] || copy[DEFAULT_LOCALE];
 const cards = document.querySelectorAll(".about__cards .wcard");
 if (cards.length !== 6) return;
 const cloud = cards[CARD_INDEX.CLOUD]?.querySelector(".wcard__demo--cloud");
 if (cloud && !cloud.querySelector(".cloud-status")) cloud.insertAdjacentHTML("beforeend", '<span class="cloud-status"><i></i>' + c + '</span>');
 const aut = cards[CARD_INDEX.AUTO];
 aut?.querySelector(".aut__bar")?.remove();
 const rules = aut?.querySelector(".aut__rules");
 if (rules) { while (rules.children.length > 4) rules.lastElementChild.remove(); }
}
