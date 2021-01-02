# CodeMirror 6 Monarch Parser
This is a 'fork' of the Monaco Editor's Monarch syntax highlighter to CodeMirror 6. It is generally compatible with Monaco Editor language sources. In contrast to the original implementation, this version of Monarch has been _radically supercharged_ with many backend improvements. The most useful new features are likely the `opens`, `closes` syntax tree additions, and the usage of sticky regexes in the backend, allowing for full lookbehind support.

## Usage
-todo-

### Why?
Monarch uses _regex_, and this particular version of it supports stupidly flexible regex. If you're a regex wizard, you'll like this.

To be more specific about _why_, we'll start with a comparison to Lezer, which is the parser CodeMirror 6 normally uses. Lezer is a proper parser, capable of outputting beautiful syntax trees with stunningly simple grammar definitions. Seriously - go look at the official Lezer grammar for `json` files - it's really tiny and simple to understand. This parser can't do that. 

However, Monarch enthusiastically allow you to commit disturbing war crimes. It has almost none of the restrictions that Lezer has. This parser can back up its input as far as you like, rematch against a token, enter phantom states, allows you to use the name of those phantom states in the tokens (wtf), now fully supports lookbehind, and probably worse things that I haven't even discovered yet. It supports all of this while not really being all that hard to use, as long as you know some regex.

If you're making an extension to Markdown, writing a wiki-lang, creating a DSL, etc. this parser might be perfect for you. If you're writing a proper grammar for a, uh, less _barbaric_ language, you'll want to make a Lezer grammar so that you get a proper syntax tree.

### Is it fast?
I think! It's definitely not slow. Monarch's runtime tokenizer is actually really tiny and simple. The most complex portions of Monarch are almost certainly its lexer compiling. The runtime itself uses _a lot_ of caching in the backend, and tries not to eat your RAM while it does it. I don't know yet how it handles really huge documents - but in theory, the method of caching the parser is using is being used to fullest extent it probably can be.

### Can I get some more technical details?
Sure! Generally, Monarch is through-and-through designed to be a simple to use tokenizer. It (in its original form) could not even nest scopes - each token got one scope, and one scope only. 

Adapting it to CodeMirror 6 required that it put out a `lezer-tree` compatible `Tree` for the incremental parser interface that CodeMirror 6 wants. To do this, this `cm6-monarch` takes the simplest approach possible, and assembles a giant freakin' buffer that it feeds into the `lezer-tree` builder.

A 'token' in Lezer looks like this:
```ts
type LezerToken = [NodeType: number, start: number, end: number, size: number]
```
However, you won't find tokens like this. It's not as simple as `[LezerToken, LezerToken, ...]`. Instead, those 4 numbers are just shoved in one buffer array in order. Parents come last - the `size` number is the amount of space in the array that node takes up. A node with no children takes up 4 slots in the array, a node with one child would take up 8. It should be noted that this is only the most basic form a syntax node can take in Lezer, a more complex tree structure could be used as well.

On a fundamental level, it's fairly simple to get Monarch to output Lezer tokens. This version of Monarch outputs this as its token:
```ts
type MonarchToken = { token: string, start: number, end: number, opens?: string, closes?: string }
//                                                                 ^ shhhhhhhh war crimes
```
Monarch parses _one line at a time_. The start and end numbers are relative to the start of the line, they're not offsets from the start of the file. Regardless, you can see how the conversion between a `LezerToken` and a `MonarchToken` would be pretty simple if you know the line offsets.

When all of these tokens are assembled, you get a big, long list of numbers. That's what is given to CodeMirror.

In order to not be stupidly slow, the parser caches information about each line in the file. The information stored, like the stack and tokens, allows the parser to start from practically anywhere in the file without needing to reparse anything prior. Additionally, the parser is smart enough to avoid parsing _too much_, and it will stop if it can just use the cache ahead as well.

Finally, the parser has a rudimentary syntax tree stack. Tokens can provide an `opens` or `closes` value, which tells the parser to 'wrap' everything after (or close the wrapping) that token with a specific scope. This is directly output into the CodeMirror syntax tree - and it can be used for things like code-folding, not just syntax highlighting. Despite the pretty tiny size of this system in the code, it's actually fairly well-behaved.

Of course, I'm skipping over quite a few technical details. There is a lot to talk about with CodeMirror - it's really, _really_ different in the backend in comparison to something like VSCode. What it gets for this complexity/efficiency is blazing fast single thread performance, and that's awesome.