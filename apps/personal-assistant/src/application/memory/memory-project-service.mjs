import { memoryProjectSlug } from "../../domain/memory-spaces.mjs";
/** Explicit membership owner; membership grants memory access, never material/Shell access. */
export class MemoryProjectService {
  constructor({ files, inbox, invalidate }) {
    Object.assign(this, { files, inbox, invalidate });
  }
  change(inputId, action, params) {
    memoryProjectSlug(params.slug);
    return this.inbox.accept(inputId, `memory.project.${action}`, params, () => {
      const result = this.files.project(action, params);
      this.invalidate();
      return result;
    });
  }
  list() {
    return this.files.projects();
  }
}
