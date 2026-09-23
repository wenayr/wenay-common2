export type ServicePanelSpec = {
    name: string;
    basePath: string;
    views: {
        name: string;
        allow: 'public' | readonly string[];
    }[];
    commands: {
        name: string;
        allow?: readonly string[];
        example: unknown;
    }[];
    login: {
        fields: string[];
    } | null;
};
export declare function servicePanelPage(spec: ServicePanelSpec): string;
