export declare function bundleApp(dir: string): Promise<Record<string, string>>;
export declare function bundleApps(appsDir: string): Promise<Record<string, Record<string, string>>>;
export declare function writeBundledApps(appsDir: string, outDir: string): Promise<string[]>;
