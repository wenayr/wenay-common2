/** Recursive plain data shared by validation and transport type projection. */
export type tJsonData = null | boolean | number | string | tJsonData[] | {[key: string]: tJsonData}
