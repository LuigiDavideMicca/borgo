import { useState } from "react";

// the contract's one hydrated component; mounted with client:load
export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button className="counter" onClick={() => setCount(count + 1)}>
      hydrated counter: {count}
    </button>
  );
}
