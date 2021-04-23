import * as React from 'react';

function SvgRedoIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg
            width="1em"
            height="1em"
            viewBox="0 0 17 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            {...props}
        >
            <path
                d="M7.889 9.355c.244 0 .43-.078.576-.225l3.803-3.832a.807.807 0 00.254-.596.846.846 0 00-.254-.596L8.465.244A.751.751 0 007.89 0c-.44 0-.782.362-.782.821 0 .205.078.4.215.567l2.385 2.327A8.694 8.694 0 008.2 3.587 8.16 8.16 0 000 11.78 8.194 8.194 0 008.211 20a8.191 8.191 0 008.202-8.22c0-.48-.343-.832-.831-.832-.47 0-.782.352-.782.831a6.577 6.577 0 01-6.589 6.608 6.58 6.58 0 01-6.598-6.608A6.556 6.556 0 018.2 5.181c.675 0 1.28.049 1.819.156L7.33 8.006a.786.786 0 00-.224.547c0 .46.342.802.782.802z"
                fill="currentColor"
            />
        </svg>
    );
}

export default SvgRedoIcon;
