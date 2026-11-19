export function wecomMention(event: {mentioned?: boolean; text?: string}): null | {kind:'command';action:string;argument:string|null} | {kind:'assistant';text:string};
