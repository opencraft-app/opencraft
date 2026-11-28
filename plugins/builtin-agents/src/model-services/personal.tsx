import {useIntl} from '@opencraft/i18n/react';
import {defineMessages} from '@opencraft/i18n';
import {lazy,Suspense,useEffect,useRef,useState,useSyncExternalStore,type ComponentType} from 'react';
import {isTouchPresentation,subscribeTouchPresentation} from '@opencraft/design-system-web/input-presentation';
import {SettingsButton,type ExtensionSettingsViewProps} from '@opencraft/extension-react';

const LazyValdiModelServicesSurface = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ValdiModelServicesMount({ viewModel }: { readonly viewModel: import("@opencraft/design-system-web/valdi").ModelServicesSurfaceProps }) {
    return <mod.ValdiSurface component={mod.ModelServicesSurface} viewModel={viewModel} style={{ width: "100%" }} />;
  }
  return { default: ValdiModelServicesMount };
});

const personalMessages=defineMessages({
  "onlyMe": {
    "id": "modelServices.personal.onlyMe",
    "defaultMessage": "Only me"
  },
  "sharedForUse": {
    "id": "modelServices.personal.sharedForUse",
    "defaultMessage": "Shared for use"
  },
  "providedByPlatform": {
    "id": "modelServices.personal.providedByPlatform",
    "defaultMessage": "Provided by platform"
  },
  "backToMyModels": {
    "id": "modelServices.personal.backToMyModels",
    "defaultMessage": "Back to my models"
  },
  "modelServices": {
    "id": "modelServices.personal.modelServices",
    "defaultMessage": "Model services"
  },
  "modelConnections": {
    "id": "modelServices.personal.modelConnections",
    "defaultMessage": "Model connections"
  },
  "searchConnections": {
    "id": "modelServices.personal.searchConnections",
    "defaultMessage": "Search connections"
  },
  "addMyConnection": {
    "id": "modelServices.personal.addMyConnection",
    "defaultMessage": "Add my connection"
  },
  "add": {
    "id": "modelServices.personal.add",
    "defaultMessage": "Add"
  },
  "myModels": {
    "id": "modelServices.personal.myModels",
    "defaultMessage": "My models"
  },
  "noPersonalConnectionsYet": {
    "id": "modelServices.personal.noPersonalConnectionsYet",
    "defaultMessage": "No personal connections yet"
  },
  "platformModels": {
    "id": "modelServices.personal.platformModels",
    "defaultMessage": "Platform models"
  },
  "managePlatformConnections": {
    "id": "modelServices.personal.managePlatformConnections",
    "defaultMessage": "Manage platform connections"
  },
  "selectAConnection": {
    "id": "modelServices.personal.selectAConnection",
    "defaultMessage": "Select a connection"
  },
  "loadingModelConnections": {
    "id": "modelServices.personal.loadingModelConnections",
    "defaultMessage": "Loading model connections…"
  },
  "tryAgain": {
    "id": "modelServices.personal.tryAgain",
    "defaultMessage": "Try again"
  },
  "connectionMethod": {
    "id": "modelServices.personal.connectionMethod",
    "defaultMessage": "Connection method"
  },
  "enterAnAPIKey": {
    "id": "modelServices.personal.enterAnAPIKey",
    "defaultMessage": "Enter an API key"
  },
  "signInToACodexSubscription": {
    "id": "modelServices.personal.signInToACodexSubscription",
    "defaultMessage": "Sign in to a Codex subscription"
  },
  "myCodexSubscription": {
    "id": "modelServices.personal.myCodexSubscription",
    "defaultMessage": "My Codex subscription"
  },
  "onlyYouAndYourAssistantsCanUse": {
    "id": "modelServices.personal.onlyYouAndYourAssistantsCanUse",
    "defaultMessage": "Only you and your assistants can use this subscription. Available allowance is determined by the provider."
  },
  "openTheSignInPageAndEnter": {
    "id": "modelServices.personal.openTheSignInPageAndEnter",
    "defaultMessage": "Open the sign-in page and enter this code:"
  },
  "openSignInPage": {
    "id": "modelServices.personal.openSignInPage",
    "defaultMessage": "Open sign-in page"
  },
  "connectsAutomaticallyAfterSignIn": {
    "id": "modelServices.personal.connectsAutomaticallyAfterSignIn",
    "defaultMessage": "Connects automatically after sign-in."
  },
  "cancel": {
    "id": "modelServices.personal.cancel",
    "defaultMessage": "Cancel"
  },
  "signInAndConnect": {
    "id": "modelServices.personal.signInAndConnect",
    "defaultMessage": "Sign in and connect"
  },
  "name": {
    "id": "modelServices.personal.name",
    "defaultMessage": "Name"
  },
  "forExampleMyCodingModel": {
    "id": "modelServices.personal.forExampleMyCodingModel",
    "defaultMessage": "For example: My coding model"
  },
  "service": {
    "id": "modelServices.personal.service",
    "defaultMessage": "Service"
  },
  "model": {
    "id": "modelServices.personal.model",
    "defaultMessage": "Model"
  },
  "apiKey": {
    "id": "modelServices.personal.apiKey",
    "defaultMessage": "API key"
  },
  "availableTo": {
    "id": "modelServices.personal.availableTo",
    "defaultMessage": "Available to"
  },
  "youAndYourAssistantsCanUseThis": {
    "id": "modelServices.personal.youAndYourAssistantsCanUseThis",
    "defaultMessage": "You and your assistants can use this connection, but other people's tasks cannot."
  },
  "save": {
    "id": "modelServices.personal.save",
    "defaultMessage": "Save"
  },
  "connectionSettings": {
    "id": "modelServices.personal.connectionSettings",
    "defaultMessage": "Connection settings"
  },
  "connectionConfigured": {
    "id": "modelServices.personal.connectionConfigured",
    "defaultMessage": "Connection configured"
  },
  "enabled": {
    "id": "modelServices.personal.enabled",
    "defaultMessage": "Enabled"
  },
  "notEnabled": {
    "id": "modelServices.personal.notEnabled",
    "defaultMessage": "Not enabled"
  },
  "usersOnThisPlatform": {
    "id": "modelServices.personal.usersOnThisPlatform",
    "defaultMessage": "Users on this platform"
  },
  "change": {
    "id": "modelServices.personal.change",
    "defaultMessage": "Change"
  },
  "whoCanUseThis": {
    "id": "modelServices.personal.whoCanUseThis",
    "defaultMessage": "Who can use this"
  },
  "accessScope": {
    "id": "modelServices.personal.accessScope",
    "defaultMessage": "Access scope"
  },
  "otherPeopleCanSelectThisConnectionUpstream": {
    "id": "modelServices.personal.otherPeopleCanSelectThisConnectionUpstream",
    "defaultMessage": "Other people can select this connection. Upstream API charges are still billed to the account that owns your key."
  },
  "allowOthersToUse": {
    "id": "modelServices.personal.allowOthersToUse",
    "defaultMessage": "Allow others to use"
  },
  "modelList": {
    "id": "modelServices.personal.modelList",
    "defaultMessage": "Model list"
  },
  "available": {
    "id": "modelServices.personal.available",
    "defaultMessage": "Available"
  },
  "advancedSettings": {
    "id": "modelServices.personal.advancedSettings",
    "defaultMessage": "Advanced settings"
  },
  "serviceAddress": {
    "id": "modelServices.personal.serviceAddress",
    "defaultMessage": "Service address"
  },
  "subscriptionSignInOnlyMe": {
    "id": "modelServices.personal.subscriptionSignInOnlyMe",
    "defaultMessage": "Subscription sign-in · Only me"
  },
  "disableConnection": {
    "id": "modelServices.personal.disableConnection",
    "defaultMessage": "Disable connection"
  },
  "stopsFutureCallsRequestsAlreadySentWill": {
    "id": "modelServices.personal.stopsFutureCallsRequestsAlreadySentWill",
    "defaultMessage": "Stops future calls. Requests already sent will still be billed."
  },
  "disable": {
    "id": "modelServices.personal.disable",
    "defaultMessage": "Disable"
  },
  "noModelServicesAreCurrentlyAvailable": {
    "id": "modelServices.personal.noModelServicesAreCurrentlyAvailable",
    "defaultMessage": "No model services are currently available."
  },
  "myUsage": {
    "id": "modelServices.personal.myUsage",
    "defaultMessage": "My usage"
  },
  "myConnectionUsage": {
    "id": "modelServices.personal.myConnectionUsage",
    "defaultMessage": "My connection usage"
  },
  "usedThisMonth": {
    "id": "modelServices.personal.usedThisMonth",
    "defaultMessage": "Used this month"
  },
  "processingOrUnconfirmed": {
    "id": "modelServices.personal.processingOrUnconfirmed",
    "defaultMessage": "Processing or unconfirmed"
  },
  "tokens": {
    "id": "modelServices.personal.tokens",
    "defaultMessage": "tokens"
  },
  "usageLimit": {
    "id": "modelServices.personal.usageLimit",
    "defaultMessage": "Usage limit"
  },
  "controlsFutureRequestsByTokenCountNot": {
    "id": "modelServices.personal.controlsFutureRequestsByTokenCountNot",
    "defaultMessage": "Controls future requests by token count, not by monetary amount. A single request may exceed its reservation."
  },
  "noPlatformAllowanceConfigured": {
    "id": "modelServices.personal.noPlatformAllowanceConfigured",
    "defaultMessage": "No platform allowance configured"
  },
  "maximumMonthlyUsage": {
    "id": "modelServices.personal.maximumMonthlyUsage",
    "defaultMessage": "Maximum monthly usage"
  },
  "saveLimit": {
    "id": "modelServices.personal.saveLimit",
    "defaultMessage": "Save limit"
  },
  "refresh": {
    "id": "modelServices.personal.refresh",
    "defaultMessage": "Refresh"
  },
  "saving": {
    "id": "modelServices.personal.saving",
    "defaultMessage": "Saving…"
  },
  "monthlyTokens": {
    "id": "modelServices.personal.monthlyTokens",
    "defaultMessage": "{count} tokens / month"
  }
});

export interface PersonalModelConnection {
  kind?:'subscription'|'api-key'|'platform';id:string;name:string;baseUrl:string;protocol:string;enabled:boolean;owned:boolean;scope:'personal'|'team';revision:number;template:boolean;
  models:{id:string;name:string;enabled:boolean}[];
}
export interface PersonalModelsDocument {
  subscriptionAvailable?:boolean;actor:string;period:string;usedTokens:number;heldTokens:number;canManage:boolean;
  limit:{monthlyTokens:number;requestTokens:number;concurrency:number}|null;
  personalLimit:{monthlyTokens:number|null;revision:number};directory:PersonalModelConnection[];
}
const path='/__opencraft_model_gateway';
const errors:Record<string,string>={
  gateway_revision_conflict:'设置已在其他位置修改。请刷新后重试，当前输入已保留。',
  gateway_identity_changed:'登录状态已改变，请重新打开设置。',
  gateway_endpoint_not_approved:'这个服务或模型已不可用，请重新选择。',
  gateway_contribution_forbidden:'无法修改这条连接，请刷新后重试。',
  gateway_sharing_consent_required:'请确认是否允许其他人使用你的额度。',
};
export async function readPersonalModels(fetcher:typeof fetch=globalThis.fetch):Promise<PersonalModelsDocument> {
  const response=await fetcher(path,{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('无法读取我的模型，请稍后重试。');
  const document=await response.json();
  if(typeof document.actor!=='string'||!Array.isArray(document.directory)||!document.personalLimit)throw Error('我的模型暂不可用。');
  return document;
}
export function createPersonalModelServicesView(fetcher:typeof fetch=globalThis.fetch, PlatformView?:ComponentType<ExtensionSettingsViewProps>) {
  return function PersonalModelServicesView(_props:ExtensionSettingsViewProps) {
    const intl=useIntl();
    const [managePlatform,setManagePlatform]=useState(false);
    const [doc,setDoc]=useState<PersonalModelsDocument|null>(null),[selected,setSelected]=useState<string|null>(null);
    const [adding,setAdding]=useState(false),[name,setName]=useState(''),[templateId,setTemplateId]=useState(''),[modelId,setModelId]=useState(''),[key,setKey]=useState('');
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[query,setQuery]=useState('');
    const [scopeOpen,setScopeOpen]=useState(false),[scope,setScope]=useState<'personal'|'team'>('personal'),[consent,setConsent]=useState(false);
    const [connectionType,setConnectionType]=useState('api-key');
    const [login,setLogin]=useState<{sessionId:string;verificationUrl:string;userCode:string;expiresAt:number}|null>(null);
    const [limitDraft,setLimitDraft]=useState(''),[limitOpen,setLimitOpen]=useState(false);
    const lifetime=useRef(0),identity=useRef<string|null>(null),pending=useRef(false);
    const apply=(next:PersonalModelsDocument)=>{
      if(identity.current!==null && identity.current!==next.actor){setLogin(null);setKey('');setName('');setAdding(false);setSelected(null);setScopeOpen(false);setLimitOpen(false);}
      identity.current=next.actor;setDoc(next);
    };
    const refresh=async()=>{const epoch=lifetime.current;try{const next=await readPersonalModels(fetcher);if(epoch===lifetime.current){apply(next);setError('');}}catch(e){if(epoch===lifetime.current)setError((e as Error).message);}};
    useEffect(()=>{void refresh();return()=>{lifetime.current++;};},[]);
    const write=async(body:Record<string,unknown>,success?:(result:any)=>void)=>{
      if(pending.current)return;pending.current=true;setBusy(true);setError('');setMessage('');
      const epoch=lifetime.current,actor=identity.current;
      try {
        const response=await fetcher(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        const result=await response.json();
        if(!response.ok)throw Error(errors[result.error]??'未能保存，请检查输入并重试。');
        const next=await readPersonalModels(fetcher);
        if(epoch!==lifetime.current)return;
        apply(next);
        if(next.actor!==actor){setError('登录状态已改变，请重新检查设置。');return;}
        success?.(result);setMessage(body.action==='subscription'?(result.status==='complete'?'订阅已连接':result.status==='pending'?'等待你完成登录':''): '已保存');
      }catch(e){if(epoch===lifetime.current)setError((e as Error).message);}
      finally{pending.current=false;if(epoch===lifetime.current)setBusy(false);}
    };
    const subscriptionResult=(result:any)=>{
      if(result.status==='complete'){setLogin(null);setSelected(result.providerId);setAdding(false);}
      else if(result.login)setLogin(result.login);
      else if(result.status==='error'){setLogin(null);setError('登录未完成，请重新登录。');}
    };
    useEffect(()=>{
      if(!login)return;
      const timer=setInterval(()=>{
        if(Date.now()>=login.expiresAt){setLogin(null);setError('登录已过期，请重新登录。');return;}
        void write({action:'subscription',operation:'poll',sessionId:login.sessionId},subscriptionResult);
      },3000);
      return()=>clearInterval(timer);
    },[login]);
    const connections=doc?.directory??[],templates=connections.filter(c=>c.template&&c.models.length);
    const connection=connections.find(c=>c.id===selected)??connections.find(c=>c.owned)??connections[0];
    const template=templates.find(c=>c.id===templateId)??templates[0],model=template?.models.find(m=>m.id===modelId)??template?.models[0];
    const visible=connections.filter(c=>c.name.toLowerCase().includes(query.toLowerCase()));
    const pick=(id:string)=>{setSelected(id);setAdding(false);setScopeOpen(false);setError('');setMessage('');};
    const add=()=>{setAdding(true);setScopeOpen(false);setError('');setMessage('');};
    const touch = useSyncExternalStore(onChange => subscribeTouchPresentation(document, onChange), () => isTouchPresentation(document), () => false);
    const scopeLabel = (c: PersonalModelConnection) =>
      c.owned
        ? (c.scope === 'personal' ? intl.formatMessage(personalMessages.onlyMe) : intl.formatMessage(personalMessages.sharedForUse))
        : intl.formatMessage(personalMessages.providedByPlatform);
    if(managePlatform&&doc?.canManage&&PlatformView)return <div className="model-services-personal__platform"><SettingsButton variant="quiet" onClick={()=>setManagePlatform(false)}>{intl.formatMessage(personalMessages.backToMyModels)}</SettingsButton><PlatformView {..._props}/></div>;
    return <div style={{ width: '100%', padding: '24px', boxSizing: 'border-box' }}>
      <Suspense fallback={null}>
        <LazyValdiModelServicesSurface
          viewModel={{
            touch,
            title: intl.formatMessage(personalMessages.modelServices),
            addLabel: intl.formatMessage(personalMessages.add),
            addDisabled: !doc || busy || (!templates.length && !doc.subscriptionAvailable),
            managePlatformLabel: intl.formatMessage(personalMessages.managePlatformConnections),
            showManagePlatform: Boolean(doc?.canManage && PlatformView),
            loading: !doc && !error,
            loadingText: intl.formatMessage(personalMessages.loadingModelConnections),
            tryAgainLabel: intl.formatMessage(personalMessages.tryAgain),
            errorMessage: error || undefined,
            statusMessage: message || undefined,
            busy,
            savingText: intl.formatMessage(personalMessages.saving),
            searchQuery: query,
            searchPlaceholder: intl.formatMessage(personalMessages.searchConnections),
            clearSearchLabel: intl.formatMessage({ id: 'settings.remoteAccess.clearInput', defaultMessage: 'Clear' }),
            myModelsTitle: intl.formatMessage(personalMessages.myModels),
            noPersonalConnectionsText: intl.formatMessage(personalMessages.noPersonalConnectionsYet),
            platformModelsTitle: intl.formatMessage(personalMessages.providedByPlatform),
            personalConnections: visible.filter(c => c.owned).map(c => ({
              id: c.id,
              name: c.name,
              scopeLabel: scopeLabel(c),
              owned: true,
              selected: !adding && connection?.id === c.id,
            })),
            platformConnections: visible.filter(c => !c.owned).map(c => ({
              id: c.id,
              name: c.name,
              scopeLabel: scopeLabel(c),
              owned: false,
              selected: !adding && connection?.id === c.id,
            })),
            adding,
            addTitle: intl.formatMessage(personalMessages.addMyConnection),
            subscriptionAvailable: doc?.subscriptionAvailable,
            connectionMethodLabel: intl.formatMessage(personalMessages.connectionMethod),
            connectionType: connectionType as 'api-key' | 'subscription',
            connectionTypeOptions: [
              { id: 'api-key', title: intl.formatMessage(personalMessages.enterAnAPIKey) },
              { id: 'subscription', title: intl.formatMessage(personalMessages.signInToACodexSubscription) },
            ],
            subscriptionTitle: intl.formatMessage(personalMessages.myCodexSubscription),
            subscriptionDescription: intl.formatMessage(personalMessages.onlyYouAndYourAssistantsCanUse),
            subscriptionLoginCode: login?.userCode,
            subscriptionLoginHint: login ? intl.formatMessage(personalMessages.connectsAutomaticallyAfterSignIn) : undefined,
            signInAndConnectLabel: intl.formatMessage(personalMessages.signInAndConnect),
            nameLabel: intl.formatMessage(personalMessages.name),
            namePlaceholder: intl.formatMessage(personalMessages.forExampleMyCodingModel),
            nameValue: name,
            serviceLabel: intl.formatMessage(personalMessages.service),
            serviceValue: template?.id ?? '',
            serviceOptions: templates.map(c => ({ id: c.id, title: c.name })),
            modelLabel: intl.formatMessage(personalMessages.model),
            modelValue: model?.id ?? '',
            modelOptions: (template?.models ?? []).map(m => ({ id: m.id, title: m.name })),
            apiKeyLabel: intl.formatMessage(personalMessages.apiKey),
            apiKeyBaseUrl: template?.baseUrl,
            apiKeyValue: key,
            availableToLabel: intl.formatMessage(personalMessages.availableTo),
            availableToHint: intl.formatMessage(personalMessages.youAndYourAssistantsCanUseThis),
            onlyMeLabel: intl.formatMessage(personalMessages.onlyMe),
            saveLabel: intl.formatMessage(personalMessages.save),
            saveDisabled: busy || !name.trim() || !key.trim() || !template || !model,
            cancelLabel: intl.formatMessage(personalMessages.cancel),
            hasSelectedConnection: Boolean(doc && connection),
            selectedConnectionName: connection?.name,
            selectedConnectionStatus: connection
              ? `${connection.owned ? intl.formatMessage(personalMessages.connectionConfigured) : intl.formatMessage(personalMessages.providedByPlatform)} · ${connection.enabled ? intl.formatMessage(personalMessages.enabled) : intl.formatMessage(personalMessages.notEnabled)}`
              : undefined,
            selectedConnectionOwned: connection?.owned,
            selectedConnectionSubscription: connection?.kind === 'subscription',
            selectedConnectionScopeText: connection
              ? (connection.scope === 'personal' ? intl.formatMessage(personalMessages.onlyMe) : intl.formatMessage(personalMessages.usersOnThisPlatform))
              : undefined,
            scopeOpen,
            scopeDraft: scope,
            scopeOptions: [
              { id: 'personal', title: intl.formatMessage(personalMessages.onlyMe) },
              { id: 'team', title: intl.formatMessage(personalMessages.usersOnThisPlatform) },
            ],
            scopeConsent: consent,
            scopeTeamWarning: intl.formatMessage(personalMessages.otherPeopleCanSelectThisConnectionUpstream),
            scopeAllowOthersLabel: intl.formatMessage(personalMessages.allowOthersToUse),
            scopeSaveDisabled: busy || !connection || scope === connection.scope || (scope === 'team' && !consent),
            changeLabel: intl.formatMessage(personalMessages.change),
            modelsTitle: intl.formatMessage(personalMessages.model),
            selectedModels: (connection?.models ?? []).map(m => ({
              id: m.id,
              name: m.name,
              statusLabel: connection?.enabled && m.enabled ? intl.formatMessage(personalMessages.available) : intl.formatMessage(personalMessages.notEnabled),
            })),
            advancedTitle: intl.formatMessage(personalMessages.advancedSettings),
            endpointLabel: connection?.kind === 'subscription' ? intl.formatMessage(personalMessages.connectionMethod) : intl.formatMessage(personalMessages.serviceAddress),
            endpointValue: connection ? (connection.kind === 'subscription' ? intl.formatMessage(personalMessages.subscriptionSignInOnlyMe) : connection.baseUrl) : undefined,
            disableLabel: intl.formatMessage(personalMessages.disableConnection),
            disableDescription: intl.formatMessage(personalMessages.stopsFutureCallsRequestsAlreadySentWill),
            disableActionLabel: intl.formatMessage(personalMessages.disable),
            emptyDirectoryText: intl.formatMessage(personalMessages.noModelServicesAreCurrentlyAvailable),
            usageTitle: intl.formatMessage(personalMessages.myConnectionUsage),
            usedThisMonthLabel: intl.formatMessage(personalMessages.usedThisMonth),
            usedThisMonthValue: doc ? `${doc.usedTokens.toLocaleString()} ${intl.formatMessage(personalMessages.tokens)}` : '0',
            heldTokensLabel: intl.formatMessage(personalMessages.processingOrUnconfirmed),
            heldTokensValue: doc && doc.heldTokens > 0 ? `${doc.heldTokens.toLocaleString()} ${intl.formatMessage(personalMessages.tokens)}` : undefined,
            usageLimitLabel: intl.formatMessage(personalMessages.usageLimit),
            usageLimitDescription: intl.formatMessage(personalMessages.controlsFutureRequestsByTokenCountNot),
            usageLimitValue: doc?.limit
              ? intl.formatMessage(personalMessages.monthlyTokens, { count: Math.min(doc.limit.monthlyTokens, doc.personalLimit.monthlyTokens ?? Infinity).toLocaleString() })
              : intl.formatMessage(personalMessages.noPlatformAllowanceConfigured),
            canEditLimit: Boolean(doc?.limit),
            limitOpen,
            limitDraft,
            limitMaxLabel: intl.formatMessage(personalMessages.maximumMonthlyUsage),
            limitSaveLabel: intl.formatMessage(personalMessages.saveLimit),
            limitSaveDisabled: busy || limitDraft.trim() === '' || !Number.isSafeInteger(Number(limitDraft)) || Number(limitDraft) < 0,
            onSearchChange: setQuery,
            onStartAdd: add,
            onCancelAdd: () => {
              if (login) {
                void write({ action: 'subscription', operation: 'cancel', sessionId: login.sessionId }, () => { setLogin(null); setAdding(false); });
              } else {
                setAdding(false);
                setKey('');
              }
            },
            onManagePlatform: () => setManagePlatform(true),
            onRefresh: () => void refresh(),
            onSelectConnection: pick,
            onConnectionTypeChange: setConnectionType,
            onStartSubscription: () => void write({ action: 'subscription', operation: 'start' }, subscriptionResult),
            onNameChange: setName,
            onServiceChange: nextId => { setTemplateId(nextId); setModelId(''); setKey(''); },
            onModelChange: setModelId,
            onApiKeyChange: setKey,
            onSaveConnection: () => void write({ action: 'contribute', name, apiKey: key, baseUrl: template!.baseUrl, protocol: template!.protocol, model: model!.id, scope: 'personal' }, result => { setKey(''); setName(''); setSelected(result.providerId); setAdding(false); }),
            onToggleScope: () => {
              if (busy || !connection) return;
              const next = !scopeOpen;
              setScopeOpen(next);
              if (next) { setScope(connection.scope); setConsent(false); }
            },
            onScopeDraftChange: nextScope => { setScope(nextScope); setConsent(false); },
            onScopeConsentChange: setConsent,
            onSaveScope: () => connection && void write({ action: 'scope', provider: connection.id, scope, revision: connection.revision, shareWithTeam: scope === 'team' }, () => setScopeOpen(false)),
            onDisableConnection: () => connection && void write({ action: 'withdraw', provider: connection.id }, () => setSelected(null)),
            onToggleLimit: () => {
              if (!doc) return;
              setLimitDraft(String(doc.personalLimit.monthlyTokens ?? doc.limit?.monthlyTokens ?? 0));
              setLimitOpen(v => !v);
            },
            onLimitDraftChange: setLimitDraft,
            onSaveLimit: () => doc && void write({ action: 'personalLimit', monthlyTokens: Number(limitDraft), revision: doc.personalLimit.revision }, () => setLimitOpen(false)),
          }}
        />
      </Suspense>
    </div>;
  };
}
