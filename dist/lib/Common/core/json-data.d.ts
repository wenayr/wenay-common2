export type tJsonData = null | boolean | number | string | tJsonData[] | {
    [key: string]: tJsonData;
};
