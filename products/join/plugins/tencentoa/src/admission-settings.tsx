import { useEffect, useRef, useState } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { SettingsActions, SettingsButton, SettingsGroup, SettingsNotice, SettingsRow, SettingsSection, SettingsSelect, SettingsTextInput, type ExtensionSettingsViewProps } from '@opencraft/extension-react';
import type { EmployeeAdmissionController } from './admission-controller';
import { employeeAdmissionExample, type EmployeeAdmissionConfig, type EmployeeAdmissionDocument } from './admission-contract';
import './admission.scss';
import { AssetDetails } from '../../../assets/details';

export function createEmployeeAdmissionSettings(controller: EmployeeAdmissionController) {
  return function EmployeeAdmissionSettings(props: ExtensionSettingsViewProps) {
    const intl = useIntl();
    const t = (message: { id: string; defaultMessage: string }) => intl.formatMessage(message);
    const [document, setDocument] = useState<EmployeeAdmissionDocument | null>(null);
    const [mode, setMode] = useState<EmployeeAdmissionConfig['mode']>(controller.draft?.mode ?? 'inherit');
    const [names, setNames] = useState(controller.draft?.mode === 'allowlist' ? controller.draft.loginNames.join('\n') : '');
    const [source, setSource] = useState(controller.draft?.mode === 'javascript' ? controller.draft.source : employeeAdmissionExample);
    const [loginName, setLoginName] = useState(''), [staffId, setStaffId] = useState('');
    const [pending, setPending] = useState<string | null>(null), [result, setResult] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const lifetime = useRef(0), edits = useRef(0);
    const config = (): EmployeeAdmissionConfig => mode === 'inherit' ? { mode } : mode === 'allowlist'
      ? { mode, loginNames: names.split(/[\s,;]+/u).filter(Boolean) } : { mode, source };
    const updateDraft = (value: EmployeeAdmissionConfig) => {
      controller.draft = value; edits.current++; setResult(null); setMode(value.mode);
      if (value.mode === 'allowlist') setNames(value.loginNames.join('\n'));
      if (value.mode === 'javascript') setSource(value.source);
    };
    const error = (e: unknown) => {
      const code = e instanceof Error ? e.message : '';
      const message = code === 'revision_conflict' ? t({ id: "ioa.access.conflict", defaultMessage: "Settings changed in another window. Reload and review your draft." })
        : code === 'cannot_remove_own_administration' ? t({ id: "ioa.access.selfLock", defaultMessage: "Include your own account before publishing this policy." })
        : code === 'administrator_required' ? t({ id: "ioa.access.adminOnly", defaultMessage: "Only server administrators can manage access." })
        : t({ id: "ioa.access.error", defaultMessage: "Unable to complete the operation. Check the policy and try again." });
      props.reportError?.({ key: 'ioa-access-policy', message });
    };
    const load = async () => {
      const generation = lifetime.current;
      setPending('load');
      try {
        const next = await controller.request();
        if (generation !== lifetime.current) return;
        setDocument(next); setFailed(false);
        if (!controller.draft && next.draft) updateDraft(next.draft);
      } catch (e) { if (generation === lifetime.current) { setFailed(true); error(e); } }
      finally { if (generation === lifetime.current) setPending(null); }
    };
    useEffect(() => { void load(); return () => { lifetime.current++; }; }, []);
    const operate = async (action: 'draft' | 'publish' | 'preview') => {
      const generation = lifetime.current, edit = edits.current;
      setPending(action); setResult(null);
      try {
        const next = await controller.request({ action, revision: document?.revision, config: config(),
          ...(action === 'preview' ? { identity: { loginName, staffId } } : {}) });
        if (generation !== lifetime.current) return;
        if (action === 'preview' && edit === edits.current) setResult(next.allow ? t({ id: "ioa.access.allowed", defaultMessage: "Allowed" }) : t({ id: "ioa.access.denied", defaultMessage: "Denied" }));
        else if (action !== 'preview') { setDocument(next); if (edit === edits.current) setResult(action === 'publish' ? t({ id: "ioa.access.published", defaultMessage: "Policy published" }) : t({ id: "ioa.access.saved", defaultMessage: "Draft saved" })); }
      } catch (e) { if (generation === lifetime.current) error(e); }
      finally { if (generation === lifetime.current) setPending(null); }
    };
    // An ordinary employee gets no admin controls or policy contents. The
    // server still authorizes every read/write; placement is not a grant.
    if (!document?.canManage) return failed ? <SettingsNotice>
      {t({ id: 'ioa.access.loadError', defaultMessage: 'Unable to load access settings. Try reloading.' })}
      <SettingsButton disabled={pending !== null} onClick={() => void load()}>{t({id:'ioa.access.reload',defaultMessage:'Reload'})}</SettingsButton>
    </SettingsNotice> : null;
    return <AssetDetails label={t({ id: 'ioa.access.advanced', defaultMessage: 'Advanced settings' })}>
      <SettingsSection title={t({ id: "ioa.access.server", defaultMessage: "Server" })} action={<SettingsButton disabled={pending !== null} onClick={() => void load()}>{t({ id: "ioa.access.reload", defaultMessage: "Reload" })}</SettingsButton>}>
        {document ? <SettingsGroup><SettingsRow label={t({ id: "ioa.access.server", defaultMessage: "Server" })}>{document.server.name}</SettingsRow></SettingsGroup>
          : <SettingsNotice>{failed ? t({ id: "ioa.access.loadError", defaultMessage: "Unable to load access settings. Try reloading." }) : t({ id: "ioa.access.loading", defaultMessage: "Loading\u2026" })}</SettingsNotice>}
      </SettingsSection>
      {document?.canManage ? <>
        <SettingsSection title={t({ id: "ioa.access.policy", defaultMessage: "Access policy" })}>
          <SettingsNotice>{t({ id: "ioa.access.scope", defaultMessage: "Applies only to verified employees on this server. Existing membership and revocations still apply." })}</SettingsNotice>
          <SettingsGroup>
            <SettingsRow label={t({ id: "ioa.access.active", defaultMessage: "Published policy" })}>{document.active?.mode === 'javascript' ? t({ id: "ioa.access.javascript", defaultMessage: "JavaScript" }) : document.active?.mode === 'allowlist' ? t({ id: "ioa.access.allowlist", defaultMessage: "Employee allowlist" }) : t({ id: "ioa.access.inherit", defaultMessage: "Keep existing admission" })}</SettingsRow>
            <SettingsRow label={t({ id: "ioa.access.mode", defaultMessage: "Draft policy" })}>
              <SettingsSelect aria-label={t({ id: "ioa.access.mode", defaultMessage: "Draft policy" })} value={mode} onChange={e => updateDraft(e.target.value === 'inherit' ? { mode: 'inherit' } : e.target.value === 'allowlist' ? { mode: 'allowlist', loginNames: names.split(/[\s,;]+/u).filter(Boolean) } : { mode: 'javascript', source })}>
                <option value="inherit">{t({ id: "ioa.access.inherit", defaultMessage: "Keep existing admission" })}</option>
                <option value="allowlist">{t({ id: "ioa.access.allowlist", defaultMessage: "Employee allowlist" })}</option>
                <option value="javascript">{t({ id: "ioa.access.javascript", defaultMessage: "JavaScript" })}</option>
              </SettingsSelect>
            </SettingsRow>
          </SettingsGroup>
          {mode === 'allowlist' ? <SettingsGroup><SettingsRow label={t({ id: "ioa.access.names", defaultMessage: "Employee accounts" })} description={t({ id: "ioa.access.namesHint", defaultMessage: "One English account per line. Case-insensitive. An empty list denies all employees." })}>
            <textarea className="settings-control-input ioa-access-editor" aria-label={t({ id: "ioa.access.names", defaultMessage: "Employee accounts" })} value={names} spellCheck={false} onChange={e => { setNames(e.target.value); controller.draft = { mode: 'allowlist', loginNames: e.target.value.split(/[\s,;]+/u).filter(Boolean) }; edits.current++; setResult(null); }} />
          </SettingsRow></SettingsGroup> : mode === 'javascript' ? <SettingsGroup><SettingsRow label={t({ id: "ioa.access.function", defaultMessage: "Admission function" })} description={t({ id: "ioa.access.functionHint", defaultMessage: "Return '{ allow: true }' or '{ allow: false }'. Errors deny access. No network or file access." })}>
            <textarea className="settings-control-input ioa-access-editor" aria-label={t({ id: "ioa.access.function", defaultMessage: "Admission function" })} value={source} spellCheck={false} onChange={e => { setSource(e.target.value); controller.draft = { mode: 'javascript', source: e.target.value }; edits.current++; setResult(null); }} />
          </SettingsRow></SettingsGroup> : null}
          <SettingsActions>
            <SettingsButton disabled={pending !== null} loading={pending === 'draft'} onClick={() => void operate('draft')}>{t({ id: "ioa.access.save", defaultMessage: "Save draft" })}</SettingsButton>
            <SettingsButton variant="primary" disabled={pending !== null} loading={pending === 'publish'} onClick={() => void operate('publish')}>{t({ id: "ioa.access.publish", defaultMessage: "Publish policy" })}</SettingsButton>
          </SettingsActions>
          <p className="ioa-access-result" role="status">{result ?? '\u00a0'}</p>
        </SettingsSection>
        <SettingsSection title={t({ id: "ioa.access.preview", defaultMessage: "Test policy" })}>
          <SettingsGroup>
            <SettingsRow label={t({ id: "ioa.access.testAccount", defaultMessage: "Example employee account" })}><SettingsTextInput aria-label={t({ id: "ioa.access.testAccount", defaultMessage: "Example employee account" })} value={loginName} onChange={e => { setLoginName(e.target.value); setResult(null); }} /></SettingsRow>
            <SettingsRow label={t({ id: "ioa.access.testId", defaultMessage: "Example employee number" })}><SettingsTextInput aria-label={t({ id: "ioa.access.testId", defaultMessage: "Example employee number" })} value={staffId} onChange={e => { setStaffId(e.target.value); setResult(null); }} /></SettingsRow>
          </SettingsGroup>
          <SettingsActions><SettingsButton disabled={pending !== null || !loginName || !staffId} loading={pending === 'preview'} onClick={() => void operate('preview')}>{t({ id: "ioa.access.run", defaultMessage: "Run test" })}</SettingsButton></SettingsActions>
        </SettingsSection>
        {!!document.versions?.length && <SettingsSection title={t({ id: "ioa.access.history", defaultMessage: "Previous policies" })}><SettingsGroup>{document.versions.map(v => <SettingsRow key={v.revision} label={intl.formatDate(v.at, { dateStyle: 'medium', timeStyle: 'short' })}>
          <SettingsButton disabled={pending !== null} onClick={() => updateDraft(v.config)}>{t({ id: "ioa.access.restore", defaultMessage: "Load as draft" })}</SettingsButton>
        </SettingsRow>)}</SettingsGroup></SettingsSection>}
      </> : null}
    </AssetDetails>;
  };
}
