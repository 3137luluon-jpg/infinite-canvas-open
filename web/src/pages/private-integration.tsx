import { Link } from "react-router-dom";

export default function PrivateIntegration({ name }: { name: string }) {
    return (
        <main className="mx-auto max-w-5xl px-6 py-12">
            <h1 className="text-2xl font-semibold">{name}</h1>
            <p className="mt-3 text-muted-foreground">这是个人插件，公开版仅保留入口。</p>
            <Link className="mt-6 inline-block text-sm underline" to="/">返回画布看板</Link>
        </main>
    );
}
