/* 场景 DSL：改这一份数据即可更换负责人、材料或检查值。页面里的「现场」也能直接改。 */
window.MATTER_DSL = {
 "version": 1,
 "teams": [
  {"id":"studio","name":"交付协作","color":"#4c7868"},
  {"id":"game","name":"活动研发","color":"#8471ac"},
  {"id":"show","name":"展览现场","color":"#ac734e"},
  {"id":"support","name":"共享支持","color":"#5a8397"},
  {"id":"market","name":"临时工市场","color":"#b58239"}
 ],
 "bots": [
  {"id":"alan","name":"阿岚","team":"studio","skills":"盯交付、管交接","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"yan","name":"言禾","team":"studio","skills":"验收签字","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"yu","name":"余白","team":"studio","skills":"交付清单","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"su","name":"苏木","team":"studio","skills":"版本发布","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"qing","name":"青禾","team":"studio","skills":"测试回执","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"lu","name":"陆乔","team":"studio","skills":"需求归档","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"mu","name":"沐川","team":"studio","skills":"客户沟通","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"jing","name":"景行","team":"studio","skills":"合同核对","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"xi","name":"小汐","team":"game","skills":"客户端实现","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"he","name":"何川","team":"game","skills":"领奖协议","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"mi","name":"米粒","team":"game","skills":"活动策划","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"ding","name":"丁一","team":"game","skills":"界面蓝图","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"an","name":"安可","team":"game","skills":"奖励配置","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"lei","name":"雷鸣","team":"game","skills":"引擎工具","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"tian","name":"田野","team":"game","skills":"活动文案","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"lin","name":"林夕","team":"game","skills":"玩家反馈","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"tang","name":"阿棠","team":"show","skills":"现场统筹","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"shan","name":"山竹","team":"show","skills":"场馆排期","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"qi","name":"祁安","team":"show","skills":"志愿者排班","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"lan","name":"蓝桥","team":"show","skills":"设备协调","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"ming","name":"明月","team":"show","skills":"交通接驳","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"qiu","name":"秋实","team":"show","skills":"展品运输","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"feng","name":"风铃","team":"show","skills":"观众指引","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"cheng","name":"程墨","team":"show","skills":"票务登记","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"xing","name":"星野","team":"support","skills":"档案检索","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"shu","name":"书遥","team":"support","skills":"素材授权","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"chen","name":"晨露","team":"support","skills":"日程核对","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"bei","name":"北辰","team":"support","skills":"文档排版","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"zhu","name":"竹音","team":"support","skills":"通知校对","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"bai","name":"白露","team":"support","skills":"名单核验","available":false,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"fold","name":"小折","team":"market","skills":"核对签字页和交付清单","available":true,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"seal","name":"印青","team":"market","skills":"检查签章与合同页码","available":true,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"luo","name":"洛洛","team":"market","skills":"模拟重复领取与晚到回包","available":true,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"fan","name":"帆帆","team":"market","skills":"复测断线重连和奖励请求","available":true,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"liao","name":"了了","team":"market","skills":"重排入场时段与志愿者轮班","available":true,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}},
  {"id":"miao","name":"苗苗","team":"market","skills":"校对场地变更后的排班","available":true,"devices":{"phone":true,"computer":{"work":true,"send":true,"hire":true,"review":""}}}
 ],
 "contacts": [
  ["alan","yan"], ["alan","su"], ["yan","yu"], ["yu","su"], ["su","qing"], ["su","mu"], ["qing","lu"], ["lu","mu"], ["mu","jing"], ["jing","alan"], ["xi","he"], ["xi","ding"], ["he","mi"], ["mi","ding"], ["ding","an"], ["ding","tian"], ["an","lei"], ["lei","tian"], ["tian","lin"], ["lin","xi"], ["tang","shan"], ["tang","lan"], ["shan","qi"], ["qi","lan"], ["lan","ming"], ["lan","feng"], ["ming","qiu"], ["qiu","feng"], ["feng","cheng"], ["cheng","tang"], ["xing","shu"], ["xing","bei"], ["shu","chen"], ["chen","bei"], ["bei","zhu"], ["zhu","bai"], ["bai","xing"], ["alan","xing"], ["xi","zhu"], ["tang","chen"], ["bei","yu"], ["jing","shu"], ["lan","ding"], ["mi","lu"], ["lei","xi"]
 ],
 "grants": [
  ["alan","yan"], ["xi","he"], ["tang","shan"], ["yan","alan"], ["he","xi"], ["shan","tang"], ["lei","xi"]
 ],
 "cases": [
  {
   "id": "release",
   "title": "周五版本交付",
   "tag": "版本交付",
   "owner": "alan",
   "peer": "yan",
   "market": ["fold","seal"],
   "artifact": "签字页核对单",
   "headline": "还差一份验收签字",
   "desktop": {"title":"周五交付清单","body":"核对交付包、测试回执、验收签字页。","paper":"sheet","mark":"签字页"},
   "nodes": [
    {"id":"matter","kind":"case","text":"周五版本交付"},
    {"id":"alan","kind":"owner"},
    {"id":"yan","kind":"peer"},
    {"id":"contract","kind":"contract"},
    {"id":"gate","kind":"gate","text":"核对版本号和签字页编号","equals":{"版本吻合":true,"签字页码":3}},
    {"id":"sandbox","kind":"sandbox","text":"核对签字页上的版本、页码和签章。","fixture":{"版本吻合":true,"签字页码":3}}
   ],
   "steps": [
    {"kind":"send","status":"待联系","summary":"交付包已齐，验收单上的签字还要核对。","action":"发送询问","source":"alan","target":"yan","message":"请把周五版本的签字页发来，我要核对交付清单。","envelope":"询问签字页","reaction":"查找盖章的签字页","desktop":{"operator":"yan","file":"签字页索引","body":"已定位本周验收单的两个附件，待核对盖章页。","input":"询问签字页"}},
    {"kind":"receive","status":"等回复","summary":"已发出询问，正在等言禾回复。","action":"模拟收到回复","source":"yan","target":"alan","message":"签字页到了。两个附件的页码不同，麻烦核对盖章的那份。","envelope":"签字页","reaction":"对照两个附件，准备请人核签","desktop":{"operator":"alan","file":"收到的签字页","body":"两份附件都已收到。页码不同，需请帮手比对签章。","input":"签字页"}},
    {"kind":"hire","status":"找帮手","summary":"签字页到了。两个附件的页码不同，麻烦核对盖章的那份。","action":"选择帮手","source":"alan","target":"contract","message":"核对签字页上的版本、页码和签章。","envelope":"核对委托","reaction":"逐页核对版本、页码和签章","desktop":{"operator":"contract","file":"逐页核签草稿","body":"逐页检查版本、页码与签章，先把候选页放进核签草稿。","input":"核对委托"}},
    {"kind":"deliver","status":"处理中","summary":"核对签字页上的版本、页码和签章。","action":"模拟交付","source":"contract","target":"alan","message":"已找到盖章的第 3 页，版本与交付清单一致。","envelope":"核签结果","reaction":"整理核对单，提交验收","desktop":{"operator":"alan","file":"签字页核对单","body":"盖章页在第 3 页，所属版本与交付清单一致。","input":"核签结果"}},
    {"kind":"confirm","status":"等你验收","summary":"已找到盖章的第 3 页，版本与交付清单一致。","action":"确认这次交付","source":"user","target":"alan","message":"签字页已确认，周五版本可以交付。","envelope":"确认交付","reaction":"归档签字页和交付清单","desktop":{"operator":"alan","file":"已签交付清单","body":"签字页已随交付清单归档。","input":"确认交付"}},
    {"kind":"done","status":"已完成","summary":"签字页已确认，周五版本可以交付。"}
   ]
  },
  {
   "id": "reward",
   "title": "限时活动领奖联调",
   "tag": "游戏研发",
   "owner": "xi",
   "peer": "he",
   "market": ["luo","fan"],
   "artifact": "领奖复测记录",
   "headline": "领奖按钮何时能打开？",
   "desktop": {"title":"领奖联调任务单","body":"核对正式协议，再复测连点领取与晚到回包。","paper":"trace","mark":"复测"},
   "nodes": [
    {"id":"matter","kind":"case","text":"限时活动领奖联调"},
    {"id":"xi","kind":"owner"},
    {"id":"he","kind":"peer"},
    {"id":"contract","kind":"contract"},
    {"id":"gate","kind":"gate","text":"核对请求次数和回包编号","equals":{"连点请求数":1,"重复弹窗数":0}},
    {"id":"sandbox","kind":"sandbox","text":"按正式协议复测连点领取与晚到回包。","fixture":{"连点请求数":1,"重复弹窗数":0}},
    {"id":"lei","kind":"reviewer"}
   ],
   "steps": [
    {"kind":"send","status":"待联系","summary":"领取按钮暂时置灰，缺少正式发奖协议。","action":"发送询问","source":"xi","target":"he","message":"这版发奖回包用哪个字段确认领取成功？","envelope":"协议询问","reaction":"查找本版本的发奖回包字段","desktop":{"operator":"he","file":"回包字段索引","body":"已定位当前版本发奖协议，准备回传字段说明。","input":"协议询问"}},
    {"kind":"receive","status":"等回复","summary":"已发出询问，正在等何川回复。","action":"模拟收到回复","source":"he","target":"xi","message":"正式协议已到，请再测一次连点领取和回包晚到。","envelope":"正式协议","reaction":"准备连点领取与晚回包用例","desktop":{"operator":"xi","file":"正式发奖协议","body":"收到正式协议，已列出连点与晚到回包两种用例。","input":"正式协议"}},
    {"kind":"hire","status":"找帮手","summary":"正式协议已到，请再测一次连点领取和回包晚到。","action":"选择帮手","source":"xi","target":"contract","message":"按正式协议复测连点领取与晚到回包。","envelope":"复测委托","reaction":"在沙盒中重放两次点击","desktop":{"operator":"contract","file":"连点复测草稿","body":"已按正式协议建立模拟用例，准备重放两次点击。","input":"复测委托"}},
    {"kind":"deliver","status":"处理中","summary":"按正式协议复测连点领取与晚到回包。","action":"模拟交付","source":"contract","target":"xi","message":"模拟中连点只发出一次请求，晚到回包未触发第二次弹窗。","envelope":"复测记录","reaction":"将请求记录交独立复核","desktop":{"operator":"xi","file":"领奖复测记录","body":"连点只发出一次请求，晚到回包没有触发重复弹窗。","input":"复测记录"}},
    {"kind":"review","status":"待独立复核","summary":"模拟复测已交付，等雷鸣核对请求与回包记录。","action":"模拟收到复核","source":"lei","target":"xi","message":"独立复核完成，模拟回包编号一致；真机发奖仍需联调。","envelope":"复核意见","reaction":"汇总真机联调前的检查项","desktop":{"operator":"xi","file":"独立复核意见","body":"复核记录已收齐。请求编号一致，仍需真机联调。","input":"复核意见"}},
    {"kind":"confirm","status":"等你验收","summary":"模拟中连点只发出一次请求，晚到回包未触发第二次弹窗。","action":"确认这次交付","source":"user","target":"xi","message":"模拟复测记录已验收，可安排进真机联调。","envelope":"模拟验收","reaction":"归档复测记录，安排真机联调","desktop":{"operator":"xi","file":"真机联调交接单","body":"模拟复测材料已归档，可交给真机联调。","input":"模拟验收"}},
    {"kind":"done","status":"已完成","summary":"模拟复测记录已验收，可安排进真机联调。"}
   ]
  },
  {
   "id": "expo",
   "title": "周末展览换场",
   "tag": "现场调度",
   "owner": "tang",
   "peer": "shan",
   "market": ["liao","miao"],
   "artifact": "换场排班表",
   "headline": "展厅换了，谁几点到？",
   "desktop": {"title":"周末入场安排","body":"确认二号厅开放时间，再重新安排两组志愿者。","paper":"schedule","mark":"入场"},
   "nodes": [
    {"id":"matter","kind":"case","text":"周末展览换场"},
    {"id":"tang","kind":"owner"},
    {"id":"shan","kind":"peer"},
    {"id":"contract","kind":"contract"},
    {"id":"gate","kind":"gate","text":"核对开放时间和班次是否冲突","equals":{"A 组入场":"14:30","B 组入场":"14:45"}},
    {"id":"sandbox","kind":"sandbox","text":"按二号厅开放时间重排两组志愿者。","fixture":{"A 组入场":"14:30","B 组入场":"14:45"}}
   ],
   "steps": [
    {"kind":"receive","status":"等场馆通知","summary":"二号厅开放时间待定，场馆有新消息就接着排班。","action":"模拟场馆来信","source":"shan","target":"tang","message":"二号厅 14:30 开放，原定 14:00 的两班需要错开。","envelope":"换场通知","reaction":"找出与新时间冲突的两个班次","desktop":{"operator":"tang","file":"场馆换场通知","body":"二号厅 14:30 开放，两组原定 14:00 的班次都需要调整。","input":"换场通知"}},
    {"kind":"hire","status":"找帮手","summary":"二号厅 14:30 开放，原定 14:00 的两班需要错开。","action":"选择帮手","source":"tang","target":"contract","message":"按二号厅开放时间重排两组志愿者。","envelope":"排班委托","reaction":"重新安排两组志愿者的入场顺序","desktop":{"operator":"contract","file":"两班排班草稿","body":"以 14:30 开放时间为准，分别安排两组志愿者。","input":"排班委托"}},
    {"kind":"deliver","status":"处理中","summary":"按二号厅开放时间重排两组志愿者。","action":"模拟交付","source":"contract","target":"tang","message":"A 组 14:30 入场，B 组 14:45 接班，两组时段均已核对。","envelope":"新排班表","reaction":"核对场馆开放时间，提交排班表","desktop":{"operator":"tang","file":"换场排班表","body":"A 组 14:30 入场，B 组 14:45 接班。","input":"新排班表"}},
    {"kind":"confirm","status":"等你验收","summary":"A 组 14:30 入场，B 组 14:45 接班，两组时段均已核对。","action":"确认这次交付","source":"user","target":"tang","message":"换场排班已确认，新的入场表可以发给现场。","envelope":"确认排班","reaction":"归档新排班表，准备通知现场","desktop":{"operator":"tang","file":"已确认入场表","body":"新的入场时段已确认，可通知两组志愿者。","input":"确认排班"}},
    {"kind":"done","status":"已完成","summary":"换场排班已确认，新的入场表可以发给现场。"}
   ]
  }
 ]
};
