# Browser

A web browser in Hearthscale's tabs. You browse in it yourself, and an app's agent, such as Ash, uses the same browser to search the web, read pages and act on them in front of you.

## Get started

Click the Browser's button on the rail, or press **Ctrl+T** for a new page. Type an address, or any other words to search with Google. The **⋯** menu holds **Find in page**, **Print…**, the zoom, your passwords, downloads and history, and **Browser settings**.

To let an agent do the browsing, ask it in a conversation:

> Find the official documentation for this library's timeout option. Explain what it controls and include the source link.

The agent reads pages in a tab you do not see, until you want to: **Show the page** puts that tab beside the conversation, exactly as the agent left it. A tab an agent drives shows a dot, so a page never changes without a sign.

## What the Browser asks for

- **Any website.** A browser loads whatever site you or an agent open, so the Browser may talk to any address on the network.
- **Browsing as you.** An agent uses the sign-ins of your Browser tabs. It never types a password and never solves a check for you: when a page asks you to sign in, or shows a check only a person can pass, the Browser hands the tab to you, and the agent goes on after you press **Done**.
- **Tools for your apps' agents.** At **Supervised**, a tool that reaches the web asks you before it runs. To keep agents out of the Browser entirely, switch off **Let the agent control the browser** in **Browser settings**.
- **Your passwords.** A password you save goes to your operating system's keychain, never to a file, and no agent can read it.
