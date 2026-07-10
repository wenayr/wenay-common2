declare type HTMLInputElement = {
    min: string;
    max: string;
    step: string;
    value: string;
    onchange: ((ev: any) => void) | null;
    onkeyup: ((ev: any) => void) | null;
    setAttribute(attr: string, val: string): void;
};
export declare function SetAutoStepForElement(element: HTMLInputElement, params?: {
    minStep?: number | undefined;
    maxStep?: number;
}): void;
export {};
