import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export const codexActivityReferenceRoot =
  "/data/mia/.runtime/lifecycle-authority-dead-contract-r3562";

/** Exact r3562 bodies. App services and unrelated tool-body rendering stay explicit test ports. */
export function loadCodexActivityFunctions(root = codexActivityReferenceRoot) {
  const fingerprints: Record<string, string> = {};
  function extract(file: string, names: readonly string[]) {
    const source = readFileSync(join(root, file), "utf8");
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    return names
      .map((name) => {
        const node = ast.statements.find(
          (statement) =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === name,
        );
        if (!node) throw new Error(`Missing ${file}#${name}`);
        const body = node.getText(ast).replace(/^export\s+/, "");
        fingerprints[`${file}#${name}`] = createHash("sha256")
          .update(body)
          .digest("hex");
        return body;
      })
      .join("\n");
  }
  const activity = extract(
    "lazy/app-initial/subagent-activity-chip-group-CC185tmV.js",
    ["DA", "TA", "fA", "pA", "mA", "OA", "_A", "gA", "ak", "ok", "Jw"],
  );
  const demotion = extract(
    "lazy/app-initial/content-reference-markers-odMp_wjH.js",
    ["je"],
  );
  const readiness = extract("editor/shared/has-displayable-content.js", [
    "hasDisplayableContent",
    "isFinalAnswerPhase",
  ]);
  return { activity, demotion, readiness, fingerprints };
}

export function createCodexActivityReferenceModule() {
  const source = loadCodexActivityFunctions();
  return {
    fingerprints: source.fingerprints,
    code: `
    import * as React from 'react';
    import * as compiler from 'react/compiler-runtime';
    import * as jsx from 'react/jsx-runtime';
    import {motion,AnimatePresence,useReducedMotion} from 'motion/react';
    import {ChevronRight} from 'lucide-react';
    import {TimelineBlockView} from '@opencraft/timeline-render-react';
    import {AgentActivityGroup} from '/apps/workbench-web/src/components/conversation-renderers/activity/agent-activity-renderers.tsx';
    const kA=compiler,vA=compiler,lk=compiler,Yw=compiler;
    const AA=React,jA=jsx,yA=jsx,dk=jsx,Xw=jsx,Gl=motion,vl=AnimatePresence,Ss=useReducedMotion;
    const X=(...args)=>args.filter(Boolean).join(' '),r={duration:.3,ease:[.19,1,.22,1]};
    const Bu=props=>jsx.jsx(ChevronRight,{...props,size:12});
    const D=({defaultMessage,values={}})=>defaultMessage.replace('{time}',values.time??'').replace('{count}',values.count??'');
    const sk=({startedAtMs,completedAtMs})=>({elapsedMs:(completedAtMs??Date.now())-startedAtMs,timeLabel:'41s'});
    const x=()=> '41s';
    const Ff=({children})=>jsx.jsx('div',{className:'min-w-0 text-size-chat relative overflow-visible py-0',children});
    // Input port: already classified Units, NOT a replacement for DA/fA/TA.
    const Fm=items=>items;
    const yn=()=>null;
    const xA=_A;
    function qk({units}) {
      return jsx.jsx('div',{className:'ref-units',children:units.map(unit=>jsx.jsx('div',{
        children:unit.kind==='group'?jsx.jsx(AgentActivityGroup,{group:unit.vela}):
          unit.item.item.type==='worked-for'?jsx.jsx(ok,unit.item.item):
          jsx.jsx(TimelineBlockView,{block:unit.vela.block})
      },unit.key))});
    }
    ${source.activity}
    ${source.readiness}
    export {DA as ReferenceActivity,isFinalAnswerPhase};
  `,
  };
}
