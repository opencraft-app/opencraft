# Telegramで個別の人格を持つHermes Agentを設定する方法

## 概要

**Telegramはあくまで入口に過ぎません。エージェントの話し方や動作、そして何をしないかを決めるのは、そのペルソナと長期コンテキストです。** フローは二つの半分に分かれています：まずチャネルガイドに従ってHermes AgentをTelegramに接続します（BotFatherでボットを作成してトークンを取得し、コンソールで接続し、接続済みと表示されることを確認します）、次にエージェントの設定ページのペルソナセクションを使用して、安定した役割、トーン、制限セットを選択し、注入します。三つのレイヤーを明確に分けておいてください：ペルソナは持続的な行動原則を保持し、ユーザーの好みはどのように扱われたいかを保持し、長期記憶は確認済みの事実やプロジェクトの背景を保持します。TelegramはグループをサポートしますBotFatherでグループプライバシーを無効にした後、ボットをグループに追加し、`@bot_username`で会話を開始した後のメッセージ。

![A Hermes Agent は Telegram において独自の個性を持ちます](../images/use-case-03-telegram-persona-agent.png)

## 対象者

このガイドは、時間をかけてTelegramで一貫した個性を持つHermes Agentを望む人向けです。
これは、パーソナルアシスタント、研究パートナー、勉強の仲間、または予測可能な方法でコミュニケーションを取るべき日常のアシスタントに適しています。

Telegramは、グループプライバシーが無効になった後、接続されたボットに言及する直接の会話やグループメッセージをサポートします。
Telegram を接続する必要がある場合は、から始めてください[チャンネルを設定 - Telegram](../configuration/channel-telegram.md)。

## 前提条件

- 進行中の LightVela Hermes Agent。
で確認または容量管理することができます。まだ作成していない場合は、まず[クイックスタート](../02-quickstart.md)。

- 動作するモデル構成または利用可能なトライアルクレジット。
Hermesがまだ返信できない場合は、完了してください[モデルの設定](../configuration/model.md)。

- 以下に従ってTelegram アカウントと接続されたボットを作成します[チャンネルを設定 - Telegram](../configuration/channel-telegram.md)。

- エージェントに担わせたい役割の最初のアイデア。
それは簡潔なリサーチアシスタント、忍耐強い学習パートナー、または実行重視のリマインダーアシスタントである可能性があります。

## 手順 / 主要な概念

### 1. Hermes AgentをTelegramに接続する

ターゲットのHermes AgentをLightVelaコンソールで開き、「チャンネル」に移動してTelegramを選択します。
従って[チャンネルを設定 - Telegram](../configuration/channel-telegram.md)ボットを作成し、HTTP APIトークンを貼り付け、テストメッセージを送信します。

コンソールで Telegram が接続済みとして表示され、ボットが Hermes Agent の返信を受け取ることを確認します。
後の問題をパーソナリティ設定の問題と区別しやすくするために、まずチャンネルを確認します。

### 2. エージェントの動作方法を記述する

特徴的なパーソナリティは、名前やキャッチフレーズ以上のものです。
設定する前に、安定させたい役割、声、作業スタイル、および境界をメモしてください。

このような短いブリーフを出発点として使用してください:

```text
You are my research assistant. Help me break down questions, compare reliable sources, and write clear conclusions.
Give the conclusion first, then the key evidence. State uncertainty instead of presenting guesses as facts.
Use a professional, direct, friendly tone. Do not be performatively cute, and do not invent certainty.
Ask for confirmation before sending messages, changing files, or taking other external actions.
```

このブリーフは、適切なソウルを選ぶのに役立ち、Telegramが接続された後にエージェントの行動を洗練するための言語を提供します。

### 3. パーソナリティからソウルを選んで注入する

対象のエージェントの設定を開き、「パーソナリティ」セクションを選択します。
「ランダムなソウルを引く」または「ソウル性格テスト」を選び、各カードの説明を確認します。

役割に最も合ったソウルを選び、「ソウルを注入」をクリックします。
LightVela は選択されたペルソナを現在の Hermes Agent の `SOUL.md` に書き込み、既存の設定を置き換える前にバックアップを保持します。

エージェントにすでに別のソウルがある場合、新しいソウルを注入すると現在アクティブなペルソナが置き換えられます。
置き換えを確認する前に、カードの役割、声、境界を確認してください。

### 4. Telegram で新しい会話を開始します

ソウルが注入された後、Telegram チャットに戻り、以下を送信してください:

```text
/new
```

Hermes Agentは新しい`SOUL.md`を、新しい会話が始まるときに読み込みます。
`/new` を送信せずに古い会話を続けると、その会話は以前のペルソナのスナップショットをまだ使用する場合があります。

新しい会話が始まったら、簡単な自己確認を促します：

```text
In three sentences, explain your current role, what you can help me with, and what you will not do for me.
```

### 5. 実際のタスクで声を調整する

「あなたは誰ですか？」と尋ねるだけで性格を判断しないでください。
日常的に実際に送るいくつかのタスクを使用します。例えば：

```text
Turn this research material into conclusions, evidence, and questions that still need confirmation.
```

```text
I have three deadlines today. Rank them by risk, then give me a concise plan.
```

```text
This request would send content to an external service. What would you do first?
```

エージェントが期待される声を維持しているか、不確かさを示すか、外部行動の境界を尊重しているかを確認します。
あなたの言語、タイムゾーン、ブリーフィング形式など、ユーザー固有の好みであれば、すべての好みをペルソナルールに変えるのではなく、Hermesに覚えてもらうように尋ねてください。

## 性格、ユーザーの好み、記憶がどのように組み合わさるか

`SOUL.md` は、エージェントの安定した役割、声、優先事項、行動の境界に最適です。
ユーザープロファイルは、あなたの身元、言語、タイムゾーン、コミュニケーションの好みに最適です。
長期記憶は、確立された事実、プロジェクトの状態、共有作業からの再利用可能なコンテキストに最適です。

詳細な説明については、 をお読みください[Hermes Agentのパーソナリティの由来](../hermes-agent/10-persona-user-memory.md)および[メモリ管理](../configuration/memory.md)。

## FAQ

### Telegram ボットには独自の性格がありますか？

パーソナリティはBotFatherトークンではなく、Telegramに接続されているHermes Agentに属します。
同じHermes Agentが他のサポートされているチャネルに接続されている場合、それらのチャネルは同じエージェントレベルのパーソナと持続可能なコンテキストを使用します。

### `/new`はメモリを削除しますか？

いいえ。
`/new`は新しい`SOUL.md`がセッション開始時に読み込まれるように、新しい会話を開始します。
それはエージェントの長期メモリやユーザープロファイルを削除しません。

### Telegramボットをグループに追加できますか？

はい、可能です。
BotFatherで`/mybots`を送信し、ボットを選択してから「Bot設定」→「グループプライバシー」を開き、プライバシーモードをオフにします。
ボットをグループに追加し、`@bot_username`で会話を開始します。
については、参照してください[チャンネルを設定 - Telegram](../configuration/channel-telegram.md)完全なセットアップのために。

### モデルを変更するとエージェントの性格は失われますか？

通常はありません。
モデル、エージェントのペルソナ、長期記憶は別々の設定層ですが、モデルを変更すると推論、ツールの使用、小さな応答スタイルの詳細が変わる可能性があります。

## 次のステップ

- [WhatsAppで独自の個性を持つHermes Agentを設定する方法](./whatsapp-persona-agent.md)- 同じエージェントの性格を1対1のWhatsApp会話に適用する。

- [IMエージェントの役割、性格、声をSOUL.mdで定義する方法](./im-agent-persona-soul-md.md)- ソウル、性格、長期記憶の境界を理解する。

- [チャンネルを設定 - Telegram](../configuration/channel-telegram.md)- 完全なTelegramボット接続フローに従う。

- [スキルを設定する](../configuration/skill.md)- 実用的なタスク能力で安定した性格を拡張する。
