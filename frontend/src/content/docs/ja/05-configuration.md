# 設定の概要

## 概要

**AgentコンソールのサイドバーにはChannels、Models、Skills、Scheduled Tasksがそれぞれ独立したページとして表示されます。設定を変える前に対象のBotを選び、チャネルのカードから接続し、モデルを選ぶかプランのクレジットを利用します。必要に応じてSkills.shまたはClawHubのスキルを追加できます。Soul、Memory、Diagnostics、Advanced Settings、Labsは別のセクションにあり、Cloud Storageはユーザーメニューから開きます。 Botがオンラインで、プランのモデルクレジットを利用できるかモデルが設定済みなら、チャネルを先に接続せずに日常のチャットから送信できます。**

---

Agentコンソールのサイドバーには日常的な設定用の**Channels**、**Models**、**Skills**、**Scheduled Tasks**があります。対象のBotを選んでから該当ページを開きます。このページでは入口と結果の確認方法を説明します。

## このページの内容

- コンソールへの入り方

- Botの切り替えと選択中Botの情報

- Channels、Models、Skills、Cloud Storageの入口

- 設定後の成功状態

- Botの管理、モデルの切り替え、複数チャネルの接続などの共通操作

---

## コンソールに入る

サインイン後、[Agent コンソール](/agents/overview/)を開き、設定する Hermes Agent と Bot を選択します。


Webチャットは日常にあります。外部アプリを使う場合のみチャネルを接続します。
---

## Botと選択中Botの情報

コンソール上部には、現在のHermes Agentに属するBotタブがあります。最初のタブがメインBotで、追加の各タブは独立したBotプロフィールです。メインBotを含む作成可能数はプランによって決まります。国際サイトでの段階的な提供中は、作成入口はデフォルトで表示されません。作成方法と継承ルールは[Botの管理](./configuration/bots.md)を参照してください。

Hermes Agentを選択すると、基本情報が下に表示されます:

- アバター

- 名前（名前または鉛筆アイコンをクリックして編集し、Enterキーを押して保存）

- ステータス（● 実行中 / ● 不明）

- 作成日時

- 削除ボタン（右側のゴミ箱アイコン）

> ⚠️ **削除は元に戻せません**
>
> 追加Botを削除すると、そのBotのプロフィールとデータが完全に削除されます。メインBotを削除するとHermes Agent全体と関連データが削除されるため、先にほかのBotをすべて削除する必要があります。

---

## チャネル・モデル・スキルを設定する

### Channels

Agentのサイドバーで**Channels**を開きます。Telegram、WhatsApp、Discord、Slack、WeChat、QQ、WeCom、Larkのカードがあり、対象の**+ Connect**から接続します。WhatsApp、WeChat、WeCom、LarkはQRコード認証、Telegram、Discord、Slackは認証情報を使用します。QQはQRコードまたはApp ID / Secretを利用できます。[WhatsAppガイド](./configuration/channel-whatsapp.md)も参照してください。

### Models

**Models**で現在のモデルを確認し、必要に応じてプロバイダーを設定します。プランのモデルクレジットは自分のAPIキーを入力せずに使えます。各Botが同時に使用するプライマリモデルは1つで、別途フォールバックモデルを設定できる場合があります。[モデルの設定](./configuration/model.md)と[モデル切り替え](./configuration/multiple-models.md)を参照してください。

### Skills

**Skills**で個別のスキルを検索するか、[Skills.sh](https://skills.sh/)と[ClawHub](https://clawhub.ai/)の**Skill Packages**を閲覧します。**Install**を選び、**Installed**で確認してください。[スキルの設定](./configuration/skill.md)も参照してください。

## 設定後の成功状態

設定が完了すると、コンソールには次の状態が表示されます：

- 「接続済みチャネル」リストには少なくとも1つのレコードがあります（例：「WeChat」）

- 「現在のモデル」は任意です。トライアルクレジットを使用する場合、設定は必要ありません

- 「インストール済みスキル」は必要に応じて設定でき、空でも構いません

「接続済みチャネル」に少なくとも1つのレコードがあると、対応するメッセージングプラットフォームでボットを見つけて会話を開始できます。Hermes Agentはデフォルトモデルまたはトライアルクレジットを使用して返信を生成します。

---

## よく使う操作

- **モデルを切り替える**：対象のBotの**Models**で設定済みの利用可能なモデルを選びます。Botのメモリは保持されます。[モデル切り替え](./configuration/multiple-models.md)を参照してください。
- **複数のチャネルを接続する**：**Channels**で必要なカードの**+ Connect**を選びます。同じBotに接続したチャネルは人設とメモリを共有します。
- **Botを管理する**：設定を変える前にBotタブを選択します。作成機能が利用できる場合は[Botの管理](./configuration/bots.md)を参照してください。
- **Cloud Storageを開く**：Agentのサイドバーではなくユーザーメニューから開きます。

---

## 次のステップ

各モジュールの詳細設定：

- [Botの管理](./configuration/bots.md)— Botの作成、コピー、切り替え、名前変更、削除

- [モデルの設定](./configuration/model.md)— モデルソース、APIキー取得、および選択のガイダンス

- [チャンネルの設定 - WeChat](./configuration/channel-wechat.md) / [Telegram](./configuration/channel-telegram.md) / [WhatsApp](./configuration/channel-whatsapp.md) / [Discord](./configuration/channel-discord.md) / [Slack](./configuration/channel-slack.md) / [QQ](./configuration/channel-qq.md) / [WeCom](./configuration/channel-wecom.md) / [Lark](./configuration/channel-feishu.md)

- [スキルを設定する](./configuration/skill.md)— Skills.sh / ClawHub の使用方法とスキルのインストール

関連参考資料:

- [コアコンセプト](./04-core-concepts.md)

- [クイックスタート](./02-quickstart.md)
