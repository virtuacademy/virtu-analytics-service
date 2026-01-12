"use client";

type FilterOption = {
  id: string;
  label: string;
  icon?: React.ReactNode;
};

type FilterBarProps = {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
};

export function FilterBar({ options, value, onChange, label }: FilterBarProps) {
  return (
    <div className="flex items-center gap-3">
      {label && (
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {label}
        </span>
      )}
      <div className="flex items-center gap-1 rounded-xl bg-zinc-900/80 p-1 border border-zinc-800/50">
        {options.map((option) => {
          const isActive = value === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              className={`
                relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium
                transition-all duration-200 ease-out
                ${
                  isActive
                    ? "bg-gradient-to-r from-blue-500/20 to-purple-500/20 text-white shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                }
              `}
            >
              {isActive && (
                <span className="absolute inset-0 rounded-lg bg-gradient-to-r from-blue-500/10 to-purple-500/10 ring-1 ring-inset ring-white/10" />
              )}
              {option.icon && <span className="relative">{option.icon}</span>}
              <span className="relative">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
