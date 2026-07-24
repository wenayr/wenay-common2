export declare function isPlainObject(v: any): boolean;
export declare function createCbShapeServer(threshold?: number, maxShapes?: number): {
    offer: (cbId: number, obj: any) => {
        mode: "full";
        shapeId?: undefined;
        keys?: undefined;
    } | {
        mode: "compact";
        shapeId: number;
        keys: string[];
    } | {
        mode: "register";
        shapeId: number;
        keys: string[];
    };
    drop: (cbId: number) => void;
};
