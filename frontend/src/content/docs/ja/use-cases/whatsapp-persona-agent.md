# WhatsAppで独自の個性を持つHermes Agentを設定する方法

## 概要

**WhatsApp はメッセージを運びます。エージェントの役割、口調、制限、長期的な文脈は LightVela の設定から来るものであり、入口を変えてもエージェント自体は変わりません。** まず WhatsApp チャンネルを接続します（チャンネルガイドに従って認可し、コンソールに接続済みと表示されることを確認してください）、その後、エージェントの設定ページのペルソナセクションを使用して、個人的なメッセージ、リマインダー、または顧客との会話に適したペルソナを選択して注入します。このエージェントが顧客やチームと対応する場合、ペルソナに対象のオーディエンスを明示し、ブランドの口調、扱える範囲、そして人間にエスカレーションする条件を追加します。接続後、テストメッセージを送信し、返信が届くことを確認してください。期待される会話において。何も届かない場合は、モデルが設定されているか、試用クレジットが使い果たされていないか、チャンネルが接続済みと表示されているかを確認してください。

![WhatsAppで個性的なHermes Agent](../images/use-case-04-whatsapp-persona-agent.png)

## 対象者

このガイドは、WhatsAppで一貫した声と有用な作業コンテキストを持つHermes Agentを望む人向けです。
特に、個人的な支援、日常のリマインダー、情報整理、そして会話のスタイルが予測可能であるべき1対1のシナリオでよく機能します。

WhatsAppは現在、主に1対1の会話を目的としています。
まだWhatsAppを接続していない場合は、から始めてください[チャンネルを設定 - WhatsApp](../configuration/channel-whatsapp.md)。

## 前提条件

- 進行中の LightVela Hermes Agent。
で確認または容量管理することができます。まだ作成していない場合は、まず[クイックスタート](../02-quickstart.md)。

- 動作するモデル構成または利用可能なトライアルクレジット。
Hermesがまだ返信できない場合は、完了してください[モデルの設定](../configuration/model.md)。

- 認証メッセージを受信できるWhatsAppアカウント、認証はを通じて完了[チャンネルを設定 - WhatsApp](../configuration/channel-whatsapp.md)。

- 簡単なパーソナリティの概要。
エージェントが誰に仕えるか、どの問題を助けるか、どのような口調にするか、どの行動が常にあなたの確認を必要とするかを決めます。

## 手順 / 主要な概念

### 1. まずWhatsAppチャネルを接続します

LightVelaコンソールで対象のHermes Agentを開き、「チャネル」へ移動し、WhatsAppを選択します。
従って[チャンネルを設定 - WhatsApp](../configuration/channel-whatsapp.md)電話認証、確認コード、またはQRフローを通じて、テストメッセージを送信します。

コンソールでWhatsAppが接続済みとして表示され、Hermes AgentがWhatsAppで返信することを確認します。
チャンネルがまだ接続されていない場合、パーソナリティを調整する前に認証、モデル、またはクレジットの問題を解決してください。

### 2. WhatsAppコンテキスト用の役割概要を作成します

WhatsAppの会話はしばしば短く即時であり、個人的なリクエストと仕事のリクエストを同じスレッドで混在させることがあります。
エージェントが誰であるかを説明するとともに、その返信の長さ、確認行動、高リスク行動の境界を定義してください。

次のような役割の概要から始めます：

```text
You are my everyday WhatsApp assistant.
Help me organize to-dos, follow-ups, and short messages, but do not take external actions without my confirmation.
Use a concise, natural, friendly tone by default. Use short sections when an explanation is needed instead of sending one long block.
If my request is missing a time, person, or goal, ask the single most important clarifying question first.
```

WhatsApp エージェントが顧客やチームに対応する場合は、「私の」を対象となるオーディエンスに置き換え、ブランドの声、対応範囲、リクエストを人間に引き渡す条件を追加してください。

### 3. パーソナリティからソウルを選んで注入する

対象のエージェントの設定を開き、「パーソナリティ」セクションを選択します。
ランダムなソウルを選ぶか、パーソナリティテストを使ってより近い一致を見つけることができます。

カード上の役割、声、行動の説明を確認し、選択して「ソウルを注入」をクリックしてください。
LightVela は選択したソウルを現在の Hermes Agent の `SOUL.md` に書き込み、以前のペルソナを置き換える前にバックアップを取ります。

エージェントには一度に一つのソウルしかアクティブになりません。
新しいソウルを挿入すると、WhatsApp は新しい会話で新しい人格を使用して返信するので、確認する前に旧役割と新役割を比較してください。

### 4. WhatsApp で新しい会話を開始します

ソウルを注入した後、このメッセージを WhatsApp の会話で送信してください：

```text
/new
```

これにより、新しい会話が始まるときに Hermes Agent が新しい `SOUL.md` を読むことができます。
もし以前の会話がまだ同じように聞こえる場合は、さらにテストを行う前に`/new`が正常に送信されたことを確認してください。

結果を確認するために短い自己チェックを行ってください：

```text
Explain who you serve, your default reply style, and what you do when a request would send a message outside this chat.
```

### 5. 実際のメッセージでWhatsAppのリズムを調整する

WhatsAppにおいて、有用な人格は特定のキャラクターのように聞こえるだけではありません。
それはメッセージの長さ、グループ化、そしてフォローアップの質問をいつするかも含まれます。

三種類のメッセージでテストしてください：

```text
Turn this content into three messages I could send to a colleague.
```

```text
Remind me to follow up on this tomorrow at 3 PM, and first tell me what information you plan to record.
```

```text
This request might trigger an external action. List the risks and what you need me to confirm first.
```

返信が長すぎる場合は、「デフォルトの返信を3つの短いセクション以内に保つ」などの設定を保存してください。
エージェントが安定したプロジェクトコンテキストを必要とする場合は、を使用します[メモリ管理](../configuration/memory.md)保持すべき事実を保存する機能。

## パーソナリティはカスタマーサービスのワークフローとは別に保ちます。

パーソナリティはエージェントが使用する役割と言葉遣いを定義します。
スキルは特定のタスクを実行できるかどうかを定義します。
スケジュールタスクはエージェントが自発的に作業を開始するタイミングを定義します。
メモリとユーザープロファイルは、どの長期的なコンテキストを保持すべきかを定義します。

例えば、親しみやすいカスタマーサービスの人格があるからといって、自動的に注文照会、ナレッジベース検索、返金機能が提供されるわけではありません。
これらの機能には、モデルの設定、スキル、参照ファイル、明示的な行動の境界が必要です。

パーソナリティ、ユーザーの好み、長期記憶の境界について詳しく知りたい場合は、こちらを読んでください[Hermes Agentのパーソナリティの由来](../hermes-agent/10-persona-user-memory.md)。

## FAQ

### 1つの WhatsApp 番号は1つの Hermes Agent に対応させるべきでしょうか？

一般的に、1つのWhatsApp番号は1つのHermes Agentに結びつけるべきです。
複数の異なる役割が必要な場合は、同じスレッドで1つの人格を何度も置き換えるのではなく、別々のWhatsApp番号とHermes Agentインスタンスを使用してください。

### 新しいソウルを注入するとWhatsAppの履歴や記憶は削除されますか？

いいえ。
新しいソウルの注入は主にエージェントの現在の`SOUL.md`を置き換えるものであり、`/new`は新しい会話を開始します。
長期記憶やユーザープロフィールは別のコンテキスト層として保持されますが、新しい人格はHermesがそのコンテキストを解釈し使用する方法を変更することがあります。

### この設定をWhatsAppグループで使うことはできますか？

現在のWhatsAppのドキュメントでは、1対1の会話がサポートされる範囲として定義されているため、グループはこのガイドには含まれていません。
確認する[チャンネルを設定 - WhatsApp](../configuration/channel-whatsapp.md)現在のチャネルの制限については、こちらをお読みください。

### WhatsAppエージェントは、能動的にメッセージを送信できますか？

能動的メッセージも、WhatsAppのメッセージテンプレートと会話ウィンドウのルールの対象となります。
スケジュールされたリマインダーを希望する場合は、こちらを読んでください[スケジュールタスク](../configuration/automation.md)そして、配信方法が実際のWhatsAppチャネルの制限に合っていることを確認してください。

## 次のステップ

- [Telegramで個別の人格を持つHermes Agentを設定する方法](./telegram-persona-agent.md)- 設定を別の国際的なメッセージングチャネルと比較してください。

- [IMエージェントの役割、性格、声をSOUL.mdで定義する方法](./im-agent-persona-soul-md.md)- パーソナリティ、ユーザープロファイル、記憶、スキルは分けて管理してください。

- [チャンネルを設定 - WhatsApp](../configuration/channel-whatsapp.md)- 完全なWhatsApp認証およびトラブルシューティングの手順に従ってください。

- [スケジュールタスク](../configuration/automation.md)- すでに会話でテストされたリマインダーやレビューをスケジュールします。
