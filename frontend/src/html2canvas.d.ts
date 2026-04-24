declare module "html2canvas" {
  interface Html2CanvasOptions {
    backgroundColor?: string | null;
    scale?: number;
    useCORS?: boolean;
    allowTaint?: boolean;
    logging?: boolean;
    imageTimeout?: number;
    onclone?: (clonedDocument: Document) => void;
  }

  export default function html2canvas(
    element: HTMLElement,
    options?: Html2CanvasOptions,
  ): Promise<HTMLCanvasElement>;
}
