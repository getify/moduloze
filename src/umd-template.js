(function UMD(name,context,dependencies,definition){
	if (typeof define === "function" && define.amd) {
		dependencies = Object.values(dependencies);
		define(name,dependencies,definition);
	}
	else if (typeof module !== "undefined" && module.exports) {
		dependencies = Object.keys(dependencies).map(p => require(p));
		module.exports = definition(...dependencies);
	}
	else {
		dependencies = Object.values(dependencies).map(n => context[n]);
		context[name] = definition(...dependencies);
	}
})(
	"..",
	(
		typeof globalThis != "undefined" ? globalThis :
		typeof global != "undefined" ? global :
		typeof window != "undefined" ? window :
		typeof self != "undefined" ? self :
		(new Function("return this"))()
	),
	{},
	function DEF(){}
);
