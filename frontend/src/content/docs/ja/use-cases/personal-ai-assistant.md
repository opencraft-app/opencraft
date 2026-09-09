# LightVelaでパーソナルAIアシスタントを作る方法

## 概要

**パーソナルAIアシスタントを作る正しい順序は、すべてを一度にスケジュールタスクすることではありません。まず、すでに使っているチャットアプリでアクセス可能なクラウドHermes Agentを作り、その後メモリ、スキル、スケジュールタスクを重ねていきます。** 5つの構成要素はそれぞれ1つの問題を解決します：モデルは推論の質を決め、チャネルはどこでアクセスするかを決め、メモリは作業方法を保持させ、スキルは再利用可能な手法を与え、スケジュールタスクはあなたが不在の間に合意した作業を完了させます。最初の1週間は、次の3つだけを行います：1つのモデルを設定し、1つのチャネルを接続し、メモリが本当にセッション間で保持されることを確認します。その経路が信頼できるようになったら、スキルとスケジュールタスクを追加します — この方法で、何かが壊れたとき、どのレイヤーが原因かを判断できます。

![チャネル全体でLightVelaを備えたパーソナルAIアシスタント](../images/use-case-personal-ai-assistant.webp)

## 対象者

この設定は、日常の計画、調査のフォローアップ、リマインダー、あなたの好みを知ることで役立つ質問に対応する1つのアシスタントが欲しい場合にうまく機能します。複雑なワークフローは必要ありません。最初は単一のHermes Agentと、すでに定期的に確認しているチャンネル1つから始めてください。

特に、自分のタイムゾーン、要約の好みの形式、取り組んでいるプロジェクト、毎朝欲しい支援の種類など、繰り返し文脈を提供することが多い場合に役立ちます。

## 前提条件

- LightVelaアカウントと稼働中のHermes Agent。まだ作成していない場合は、まずこちらから始めてください。[クイックスタート](https://lightvela.ai/docs/quickstart)。

- 1つの会話チャネル。Telegram、WhatsApp、Discord、Slack、およびWeChatは一般的な開始点です。毎日最も開く可能性が高いものを選んでください。

- 動作中のモデル構成または利用可能な試用クレジット。参照してください[モデルの設定](https://lightvela.ai/docs/configuration/model)もしHermesがまだ返信できない場合。

- 最初に助けが欲しいことの簡単なアイデア。1つのルーチン、例えば1日の計画やフォローアップの収集で十分です。

## 手順 / 主要な概念

### 1. Hermesをあなたの日課に組み込む

1つのメッセージングチャネルを接続し、通常の日常を整理する場所から最初の数件のメッセージを送信します。チャネルは単なる配信手段ではなく、アシスタントを簡単に戻って利用できる習慣です。次のセットアップページに従ってください[Telegram](https://lightvela.ai/docs/configuration/channel-telegram), [WhatsApp](https://lightvela.ai/docs/configuration/channel-whatsapp), [Discord](https://lightvela.ai/docs/configuration/channel-discord), [Slack](https://lightvela.ai/docs/configuration/channel-slack)や[WeChat](https://lightvela.ai/docs/configuration/channel-wechat)。

![LightVelaコンソールのチャネルページ](../images/personal-ai-assistant-channel.webp)

広範なリクエストよりも、まず明確な紹介から始めてください。例えば：

```text
I want you to be my personal planning assistant. I am in Singapore time.
Keep daily plans short, call out deadlines first, and ask one follow-up question when something is unclear.
```

### 2. 繰り返される文脈はメモリに任せる

ヘルメスは時間をかけて有用なコンテキストを構築するため、毎回の会話ですべての好みを繰り返す必要はありません。役立つであろう事実や作業上の好みを伝えてください：あなたのタイムゾーン、ブリーフィングの構成方法、重要なプロジェクト名、または計画を立てたい日など。

要求を直接伝えることもできます：

```text
Remember that I prefer a concise weekday briefing at 8:00 AM,
with meetings, deadlines, and the three most important next actions.
```

次の[メモリ管理](https://lightvela.ai/docs/configuration/memory)ページで、Hermesが蓄積したメモリとユーザープロファイル情報を確認します。メモリは繰り返しを減らすためのものであり、あらゆる通過情報の捨て場になるべきではありません。

### 3. 実際の作業で必要な場合にのみスキルを追加する

Hermesは追加のスキルがなくてもチャットできます。情報の検索、やることリストの整理、定期レポートの作成など、実際の仕事で役立つスキルが思いついたら追加してください。これにより、アシスタントは理解しやすく、信頼しやすくなります。

![LightVelaコンソールのスキルページ](../images/personal-ai-assistant-skills.webp)

ClawHubで適切なオプションを閲覧し、その後で使用してください[スキルを設定する](https://lightvela.ai/docs/configuration/skill)でインストールします。何かをインストールする前に、その説明を読み、信頼できるソースを選んでください。

### 4. 役立つ会話を繰り返し使えるチェックインに変える

プロンプトが確実に役立つようになったら、それをスケジュールで実行するかどうかを決めてください。簡単なスケジュールタスクで、ヘルメスに朝の計画や一日の終わりのレビュー、週ごとのリセットを依頼でき、会話を始めることをあなたが思い出す必要はありません。

例えば：

```text
Every weekday at 8:00 AM, prepare a concise plan for today.
Start with deadlines and meetings, then suggest three focused next actions.
```

でスケジュールと通知チャネルを設定します。最初のスケジュールタスクは小さく保ち、実際の結果をいくつか確認した後で指示を改善できます。[スケジュールタスク](https://lightvela.ai/docs/configuration/automation)。

![LightVelaコンソールのスケジュールタスクページ](../images/personal-ai-assistant-automations.webp)

## FAQ

### ヘルメスが役立つようになる前に、すべての機能を設定する必要がありますか？

いいえ。始めるためには、チャンネルと作業モデルがあれば十分です。どの繰り返しタスクを残す価値があるかを発見するにつれて、徐々にメモリ、スキル、スケジュールタスクを追加してください。

### Hermesは私が送るすべてのメッセージを覚えますか？

いいえ。メモリは、会話を超えて有用な情報、例えば好みや繰り返し作業、安定したコンテキストなどを保持するために意図されています。必要に応じてHermesに情報を覚えさせたり忘れさせたりすることができ、その後メモリ管理で確認できます。

### 複数のチャンネルから同じアシスタントを使うことはできますか？

はい。複数の接続されたチャネルが同じHermes Agentを指すことができるため、サポートされているメッセージングプラットフォーム間を移動してもアシスタントは同じコンテキストを保持できます。

### まず何をスケジュールタスクすべきですか？

既に予測可能な時間に繰り返しているタスクを選んでください。朝の計画、短い日次レビュー、または週次の優先事項確認は、出力が役立っているかをすぐに判断できるため、最初の候補として適しています。

## 次のステップ

- [チャット](https://lightvela.ai/docs/configuration/agent-chat)— コンソールで直接Hermesと作業します。

- [メモリ管理](https://lightvela.ai/docs/configuration/memory)— アシスタントが会話全体で保持する内容を確認します。

- [スケジュールタスク](https://lightvela.ai/docs/configuration/automation)— 役立つルーチンをスケジュールする。
