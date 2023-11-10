import { Column, Text, Row } from '@react-email/components'
import * as React from 'react'

import { EmailHtml, HighlightLogo } from '../components/common'
import {
	AlertContainer,
	Break,
	CtaLink,
	Footer,
	highlightedTextStyle,
	Subtitle,
	textStyle,
	Title,
} from '../components/alerts'

export interface LogAlertEmailProps {
	projectName?: string
	alertName?: string
	alertLink?: string
	query?: string
	logsLink?: string
	belowThreshold?: boolean
	count?: number
	threshold?: number
}

export const LogAlertEmail = ({
	projectName = 'Highlight Production (app.highlight.io)',
	alertName = 'Log Alert',
	alertLink = 'https://localhost:3000/1/alerts/logs/1',
	query = 'level:info',
	logsLink = 'https://localhost:3000/1/logs',
	belowThreshold = false,
	count = 24,
	threshold = 20,
}: LogAlertEmailProps) => (
	<EmailHtml previewText={`${alertName} alert fired`}>
		<HighlightLogo />
		<Title>
			<span style={highlightedTextStyle}>{alertName}</span> alert fired
		</Title>
		<Subtitle>{projectName}</Subtitle>

		<AlertContainer>
			<Text style={textStyle}>
				Log count for query{' '}
				<span style={highlightedTextStyle}>{query}</span> is currently{' '}
				{belowThreshold ? 'below' : 'above'} the threshold.
			</Text>

			<Break />

			<Row style={statContainer}>
				<Column>
					<Text style={leftStat}>
						<span style={statHeader}>Count</span>
						{count}
					</Text>
				</Column>
				<Column>
					<Text style={rightStat}>
						<span style={statHeader}>Threshold</span>
						{threshold}
					</Text>
				</Column>
			</Row>
			<CtaLink href={logsLink} label="View logs" />
		</AlertContainer>

		<Break />

		<Footer alertLink={alertLink} />
	</EmailHtml>
)

export default LogAlertEmail

const statContainer = {
	marginBottom: '12px',
}

const leftStat = {
	...textStyle,
	textAlign: 'left' as const,
}

const rightStat = {
	...textStyle,
	textAlign: 'right' as const,
}

const statHeader = {
	...textStyle,
	color: '#9d97aa',
	marginRight: '8px',
}
