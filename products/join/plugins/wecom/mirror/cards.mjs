// Interactive template cards sent through the Relay: the card definition is kept so a
// click can be answered within the provider's 5-second ResponseCode window, without
// a round trip to the receiving server.

/** Readable outcome of a card event, using the labels the card was sent with. */
export function describeChoice(card, event) {
  if (event.eventKey === 'oc-skip') return '不选了';
  const button = card?.button_list?.find(b => b.key === event.eventKey);
  if (button) return button.text;
  const labels = [];
  const questions = [card?.checkbox, ...(card?.select_list ?? []), card?.button_selection].filter(Boolean);
  for (const item of event.selected ?? []) {
    const question = questions.find(q => q.question_key === item.questionKey);
    const names = item.optionIds.map(id => question?.option_list?.find(o => o.id === id)?.text ?? id);
    labels.push((question?.title ? question.title + '：' : '') + names.join('、'));
  }
  if (labels.length) return labels.join('；');
  return event.eventKey || '已提交';
}

/** The answered card, using only documented update fields: a result line, and disabled selectors. */
export function answeredCard(card, actor, choice) {
  const result = `✅ ${actor} 已选择：${choice}`;
  const base = { card_type: card.card_type, ...(card.source && { source: card.source }), main_title: {...card.main_title,desc:result} };
  if (card.card_type === 'button_interaction')
    return { ...base, sub_title_text:result, button_list: card.button_list, ...(card.horizontal_content_list && { horizontal_content_list: card.horizontal_content_list }),
      ...(card.button_selection && { button_selection: { ...card.button_selection, disable: true } }) };
  if (card.card_type === 'vote_interaction')
    return { ...base, checkbox: { ...card.checkbox, disable: true }, submit_button: { ...card.submit_button, text: '已提交' } };
  if (card.card_type === 'multiple_interaction')
    return { ...base, select_list: card.select_list.map(s => ({ ...s, disable: true })), submit_button: { ...card.submit_button, text: '已提交' } };
  return { card_type: 'text_notice', main_title: card.main_title, sub_title_text: result, card_action: { type: 1, url: 'https://work.weixin.qq.com' } };
}

/** Timeline text recorded in the bound OpenCraft group. */
export const timelineText = (card, choice) => `[卡片] ${card?.main_title?.title ?? '交互卡片'} → ${choice}`;
