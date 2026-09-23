export type tFieldKind = 'string' | 'number' | 'boolean' | 'date-string';
type tCompositeSpec = {
    enum: readonly string[];
} | {
    array: tArrayItemSpec;
} | {
    object: tInputSchema;
};
export type tArrayItemSpec = tFieldKind | (tCompositeSpec & {
    optional?: never;
});
export type tFieldSpec = tFieldKind | `${tFieldKind}?` | (tCompositeSpec & {
    optional?: true;
});
export type tInputSchema = {
    [field: string]: tFieldSpec;
};
type tScalar<K extends tFieldKind> = K extends 'number' ? number : K extends 'boolean' ? boolean : string;
type tSpecValue<Sp> = Sp extends `${infer K extends tFieldKind}?` ? tScalar<K> : Sp extends tFieldKind ? tScalar<Sp> : Sp extends {
    enum: readonly (infer E extends string)[];
} ? E : Sp extends {
    array: infer Item;
} ? tSpecValue<Item>[] : Sp extends {
    object: infer O extends tInputSchema;
} ? InferInput<O> : never;
type tIsOptional<Sp> = Sp extends `${string}?` ? true : Sp extends {
    optional: true;
} ? true : false;
type tFlat<T> = {
    [K in keyof T]: T[K];
} & {};
export type InferInput<Sch extends tInputSchema> = tFlat<{
    [K in keyof Sch as tIsOptional<Sch[K]> extends true ? never : K]: tSpecValue<Sch[K]>;
} & {
    [K in keyof Sch as tIsOptional<Sch[K]> extends true ? K : never]?: tSpecValue<Sch[K]>;
}>;
export declare function buildInputValidate(schema: tInputSchema): (input: unknown) => void;
export declare function inputJsonSchema(schema: tInputSchema): {
    type: string;
    properties: Record<string, object>;
    required?: string[] | undefined;
    additionalProperties: boolean;
};
export declare function schemaCommand<const Sch extends tInputSchema, Ctx, R>(input: Sch, command: {
    validate?: (input: InferInput<Sch>) => void;
    apply: (ctx: Ctx, input: InferInput<Sch>) => R;
    allow?: readonly string[];
    limit?: {
        perMinute: number;
    };
}): {
    validate?: (input: InferInput<Sch>) => void;
    apply: (ctx: Ctx, input: InferInput<Sch>) => R;
    allow?: readonly string[];
    limit?: {
        perMinute: number;
    };
    input: Sch;
};
export {};
