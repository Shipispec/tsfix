// LLM trained on React 19 docs writes `useActionState`. Against
// react@18 (installed in _shared) the export does not exist —
// TS2305. The hook was named `useFormState` in v18 and lived in
// 'react-dom', not 'react'. Auto-renaming to a similar-looking
// existing export would be wrong; fixer must leave it for mend.

import { useActionState } from "react";

type State = { count: number };

function reducer(prev: State, _formData: FormData): State {
	return { count: prev.count + 1 };
}

export function useCounter() {
	const [state, dispatch, pending] = useActionState(reducer, { count: 0 });
	return { state, dispatch, pending };
}
