export type tConversationData = null | boolean | number | string | tConversationData[] | {
    [key: string]: tConversationData;
};
export declare function copyConversationData(value: unknown, label?: string): tConversationData;
