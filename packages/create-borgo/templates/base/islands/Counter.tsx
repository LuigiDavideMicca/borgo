import { useState } from "react";

export default function Counter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);
  return (
    <button type="button" className="counter" onClick={() => setCount((c) => c + 1)}>
      clicked {count} {count === 1 ? "time" : "times"}
    </button>
  );
}
