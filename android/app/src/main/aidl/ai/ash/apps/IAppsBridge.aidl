package ai.ash.apps;

import android.os.ParcelFileDescriptor;

// The apps shell (process ":app") calls Ash (the main process) through this: one word to one member as the owner,
// `bodyJson` the body as JSON (at most 256K characters), the answer the `Reply` as JSON {ok, result?: {data?, content?}} |
// {ok: false, error}, UTF-8, read from the pipe this returns (a Binder transaction holds only about 1 MB, and a page or an
// icon is bigger than that); null when there is none.
interface IAppsBridge {
    ParcelFileDescriptor call(String to, String word, String bodyJson);
}
