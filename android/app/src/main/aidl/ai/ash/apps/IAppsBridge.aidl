package ai.ash.apps;

// The apps shell (process ":app") calls Ash (the main process) through this: one word to one member as the owner,
// `bodyJson` the body as JSON, the answer the `Reply` as JSON: {ok, result?: {data?, content?}} | {ok: false, error}.
interface IAppsBridge {
    String call(String to, String word, String bodyJson);
}
