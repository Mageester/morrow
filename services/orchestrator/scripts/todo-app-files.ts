// The exact files a Morrow agent would create for the Todo-app consumer test.
// Kept in one module so the proof script stays readable.

export const TODO_APP_FILES: Array<{ path: string; content: string }> = [
  {
    path: "package.json",
    content: `{
  "name": "morrow-todo-app",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.10"
  }
}
`,
  },
  {
    path: "index.html",
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Todo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  },
  {
    path: "vite.config.ts",
    content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
  },
  {
    path: "tsconfig.json",
    content: `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src", "vite.config.ts"]
}
`,
  },
  {
    path: "src/vite-env.d.ts",
    content: `/// <reference types="vite/client" />
`,
  },
  {
    path: "src/main.tsx",
    content: `import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
  },
  {
    path: "src/useLocalStorage.ts",
    content: `import { useEffect, useState } from "react";

export function useLocalStorage<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [key, value]);

  return [value, setValue];
}
`,
  },
  {
    path: "src/types.ts",
    content: `export interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

export type Theme = "light" | "dark";
`,
  },
  {
    path: "src/App.tsx",
    content: `import { useState } from "react";
import type { Theme, Todo } from "./types";
import { useLocalStorage } from "./useLocalStorage";

export function App() {
  const [todos, setTodos] = useLocalStorage<Todo[]>("morrow.todos", []);
  const [theme, setTheme] = useLocalStorage<Theme>("morrow.theme", "light");
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const remaining = todos.filter((t) => !t.completed).length;

  function addTodo() {
    const title = draft.trim();
    if (!title) return;
    setTodos([{ id: crypto.randomUUID(), title, completed: false }, ...todos]);
    setDraft("");
  }

  function toggle(id: string) {
    setTodos(todos.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));
  }

  function remove(id: string) {
    setTodos(todos.filter((t) => t.id !== id));
  }

  function startEdit(todo: Todo) {
    setEditingId(todo.id);
    setEditingText(todo.title);
  }

  function commitEdit() {
    if (editingId === null) return;
    const title = editingText.trim();
    setTodos(
      title
        ? todos.map((t) => (t.id === editingId ? { ...t, title } : t))
        : todos.filter((t) => t.id !== editingId),
    );
    setEditingId(null);
    setEditingText("");
  }

  return (
    <div className={\`app app--\${theme}\`}>
      <header className="app__header">
        <h1>Todo</h1>
        <button
          className="app__theme"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label="Toggle theme"
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>
      </header>

      <form
        className="app__add"
        onSubmit={(e) => {
          e.preventDefault();
          addTodo();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What needs doing?"
          aria-label="New todo"
        />
        <button type="submit">Add</button>
      </form>

      <ul className="app__list">
        {todos.map((todo) => (
          <li key={todo.id} className={todo.completed ? "done" : undefined}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggle(todo.id)}
              aria-label={\`Complete \${todo.title}\`}
            />
            {editingId === todo.id ? (
              <input
                className="app__edit"
                autoFocus
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <span onDoubleClick={() => startEdit(todo)}>{todo.title}</span>
            )}
            <button className="app__delete" onClick={() => remove(todo.id)} aria-label="Delete">
              ✕
            </button>
          </li>
        ))}
      </ul>

      <footer className="app__footer">
        {todos.length === 0 ? "No todos yet." : \`\${remaining} remaining\`}
      </footer>
    </div>
  );
}
`,
  },
  {
    path: "src/index.css",
    content: `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.app {
  max-width: 640px;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  min-height: 100vh;
}

.app--light {
  background: #ffffff;
  color: #14181f;
}

.app--dark {
  background: #14181f;
  color: #e8ecf2;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app__theme {
  border: none;
  background: transparent;
  font-size: 1.4rem;
  cursor: pointer;
}

.app__add {
  display: flex;
  gap: 0.5rem;
  margin: 1rem 0;
}

.app__add input {
  flex: 1;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  border: 1px solid #8a93a2;
  background: transparent;
  color: inherit;
  font-size: 1rem;
}

.app__add button,
.app__list button {
  cursor: pointer;
}

.app__add button {
  padding: 0.6rem 1rem;
  border-radius: 8px;
  border: none;
  background: #3b82f6;
  color: #fff;
  font-size: 1rem;
}

.app__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.app__list li {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  border: 1px solid #8a93a244;
}

.app__list li span {
  flex: 1;
}

.app__list li.done span {
  text-decoration: line-through;
  opacity: 0.55;
}

.app__edit {
  flex: 1;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #3b82f6;
  background: transparent;
  color: inherit;
  font-size: 1rem;
}

.app__delete {
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  font-size: 1rem;
}

.app__footer {
  margin-top: 1.25rem;
  opacity: 0.7;
  font-size: 0.9rem;
}

@media (max-width: 480px) {
  .app {
    padding: 1rem 0.75rem 2rem;
  }
  .app__add {
    flex-direction: column;
  }
}
`,
  },
];
